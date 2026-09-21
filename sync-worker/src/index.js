import Papa from 'papaparse';

// Ограничение: сколько каналов обрабатывать за 1 запуск,
// чтобы не вылезать за лимиты подзапросов Cloudflare
const BATCH_LIMIT = 50; 

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
    processedFromSheets: 0,
    addedOrUpdatedInDB: 0,
    errors: []
  };

  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    result.errors.push({ step: "init", error: "YOUTUBE_API_KEY secret is not set" });
    return result;
  }

  if (!env.GOOGLE_SHEET_CSV_URL) {
    result.errors.push({ step: "init", error: "GOOGLE_SHEET_CSV_URL secret is not set" });
    return result;
  }

  try {
    // 1. Загружаем Google Sheet
    const sheetRes = await fetch(env.GOOGLE_SHEET_CSV_URL);
    const csvText = await sheetRes.text();

    const { data: rows } = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true
    });

    // 2. Собираем уникальные каналы из таблицы (id + status)
    const pendingChannels = new Map();

    for (const row of rows) {
      const rawUrl = row['URL-адреса місця розташування'] || row['url'] || row['URL'] || Object.values(row)[0];
      const rawStatus = row['status'] || row['статус'] || 'black';

      if (!rawUrl) continue;

      const channelId = parseChannelId(rawUrl);
      if (!channelId) continue;

      const statusValue = String(rawStatus).trim().toLowerCase() === 'white' ? 'white' : 'black';
      pendingChannels.set(channelId, statusValue);
    }

    result.processedFromSheets = pendingChannels.size;

    // 3. Достаем список ID для обработки текущей порцией (BATCH_LIMIT)
    const allChannelIds = Array.from(pendingChannels.keys()).slice(0, BATCH_LIMIT);

    if (allChannelIds.length === 0) {
      return result;
    }

    // 4. Пакетно запрашиваем данные у YouTube API (по 50 штук за раз)
    const updateBatch = [];

    for (let i = 0; i < allChannelIds.length; i += 50) {
      const chunkIds = allChannelIds.slice(i, i + 50);

      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${chunkIds.join(',')}&key=${apiKey}`
      );
      const chData = await chRes.json();

      if (!chData.items || chData.items.length === 0) continue;

      for (const item of chData.items) {
        const id = item.id;
        const snippet = item.snippet || {};
        const stats = item.statistics || {};

        const name = snippet.title;
        if (!name) continue; // Пропускаем, если имени нет

        const country = snippet.country || 'XX';
        const language = snippet.defaultLanguage || snippet.audioLanguage || 'uk';
        const subscribers = Number(stats.subscriberCount || 0);
        const status = pendingChannels.get(id) || 'black';

        // Формируем запрос на добавление уже ПОЛНОСТЬЮ ЗАПОЛНЕННОЙ записи
        updateBatch.push(
          env.DB.prepare(`
            INSERT INTO channels (id, name, country, language, subscribers, status, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'sheet_import', datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              country = excluded.country,
              language = excluded.language,
              subscribers = excluded.subscribers,
              status = excluded.status,
              updated_at = datetime('now')
          `).bind(id, name, country, language, subscribers, status)
        );
      }
    }

    // 5. Записываем в D1 только готовые записи
    if (updateBatch.length > 0) {
      await env.DB.batch(updateBatch);
      result.addedOrUpdatedInDB = updateBatch.length;
    }

  } catch (e) {
    result.errors.push({ step: "sync_process", error: String(e) });
  }

  return result;
}

function parseChannelId(url) {
  if (!url) return null;
  const match = url.match(/channel\/([\w-]+)/) || url.match(/@([\w-]+)/);
  return match ? match[1] : null;
}
