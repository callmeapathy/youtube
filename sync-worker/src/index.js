import Papa from 'papaparse';

const BATCH_LIMIT = 100; // Сколько каналов обогащать через YouTube API за 1 запуск

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await syncChannels(env);
      return Response.json(result);
    }
    return new Response("YT Placements sync worker. GET /run to trigger manually.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncChannels(env));
  },
};

async function syncChannels(env) {
  const result = {
    sheetsImported: 0,
    ytUpdated: 0,
    errors: []
  };

  // -------------------------------------------------------------
  // ЭТАП 1: Безопасный пакетный импорт из Google Sheets
  // -------------------------------------------------------------
  if (env.GOOGLE_SHEET_CSV_URL) {
    try {
      const sheetRes = await fetch(env.GOOGLE_SHEET_CSV_URL);
      const csvText = await sheetRes.text();

      const { data: rows } = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true
      });

      const batchStatements = [];

      // Ограничиваем количество обработанных строк за один прогон (максимум 500 штук),
      // чтобы не упереться в лимиты Cloudflare Worker Invocation
      const maxRowsToProcess = Math.min(rows.length, 500);

      for (let i = 0; i < maxRowsToProcess; i++) {
        const row = rows[i];
        const rawUrl = row['URL-адреса місця розташування'] || row['url'] || row['URL'] || Object.values(row)[0];
        const rawStatus = row['status'] || row['статус'] || 'black';
        const initialName = row['Виключення'] || row['name'] || 'Pending...';
        
        if (!rawUrl) continue;

        const channelId = parseChannelId(rawUrl);
        if (!channelId) continue;

        const statusValue = String(rawStatus).trim().toLowerCase() === 'white' ? 'white' : 'black';

        batchStatements.push(
          env.DB.prepare(`
            INSERT INTO channels (id, name, status, source, created_at, updated_at)
            VALUES (?, ?, ?, 'sheet_import', datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              name = CASE WHEN channels.name IS NULL OR channels.name = 'Pending...' THEN excluded.name ELSE channels.name END
          `).bind(channelId, initialName, statusValue)
        );
      }

      // Выполняем запись крупными пакетами по 100 операций за раз
      const CHUNK_SIZE = 100;
      for (let i = 0; i < batchStatements.length; i += CHUNK_SIZE) {
        const chunk = batchStatements.slice(i, i + CHUNK_SIZE);
        await env.DB.batch(chunk);
        result.sheetsImported += chunk.length;
      }

    } catch (e) {
      result.errors.push({ step: "google_sheets_import", error: String(e) });
    }
  } else {
    result.errors.push({ step: "google_sheets_import", error: "GOOGLE_SHEET_CSV_URL secret is not set" });
  }

  // -------------------------------------------------------------
  // ЭТАП 2: Заполнение названий, страны, языка и подписчиков с YouTube API
  // -------------------------------------------------------------
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    result.errors.push({ step: "youtube_sync", error: "YOUTUBE_API_KEY secret is not set" });
    return result;
  }

  try {
    // Берем каналы, у которых еще нет настоящего имени или которые давно не обновлялись
    const { results: staleChannels } = await env.DB.prepare(
      `SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?`
    ).bind(BATCH_LIMIT).all();

    if (staleChannels && staleChannels.length > 0) {
      const channelIds = staleChannels.map(c => c.id);

      // Запрашиваем данные пачками по 50 каналов за один вызов API
      for (let i = 0; i < channelIds.length; i += 50) {
        const chunkIds = channelIds.slice(i, i + 50);
        
        const chRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${chunkIds.join(',')}&key=${apiKey}`
        );
        const chData = await chRes.json();

        if (chData.items && chData.items.length > 0) {
          const updateBatch = [];

          for (const item of chData.items) {
            const id = item.id;
            const snippet = item.snippet || {};
            const stats = item.statistics || {};

            const name = snippet.title || 'Unknown Channel';
            const country = snippet.country || 'XX';
            const language = snippet.defaultLanguage || snippet.audioLanguage || 'uk';
            const subscribers = Number(stats.subscriberCount || 0);

            updateBatch.push(
              env.DB.prepare(`
                UPDATE channels
                SET 
                  name = COALESCE(NULLIF(?, ''), name),
                  country = COALESCE(NULLIF(?, ''), country),
                  language = COALESCE(NULLIF(?, ''), language),
                  subscribers = ?,
                  updated_at = datetime('now')
                WHERE id = ?
              `).bind(name, country, language, subscribers, id)
            );
          }

          if (updateBatch.length > 0) {
            await env.DB.batch(updateBatch);
            result.ytUpdated += updateBatch.length;
          }
        }
      }
    }

  } catch (e) {
    result.errors.push({ step: "youtube_sync_batch", error: String(e) });
  }

  return result;
}

function parseChannelId(url) {
  if (!url) return null;
  const match = url.match(/channel\/([\w-]+)/) || url.match(/@([\w-]+)/);
  return match ? match[1] : null;
}
