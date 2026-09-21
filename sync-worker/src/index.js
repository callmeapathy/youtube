import Papa from 'papaparse';

const BATCH_LIMIT = 40; // Сколько каналов обновлять через YouTube API за один раз

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
  // ЕТАП 1: Пакетне завантаження з Google Sheets в D1
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

      for (const row of rows) {
        const rawUrl = row['URL-адреса місця розташування'] || row['url'] || row['URL'] || Object.values(row)[0];
        const rawStatus = row['status'] || row['статус'] || 'black';
        const initialName = row['Виключення'] || row['name'] || 'Pending...';
        
        if (!rawUrl) continue;

        const channelId = parseChannelId(rawUrl);
        if (!channelId) continue;

        const statusValue = String(rawStatus).trim().toLowerCase() === 'white' ? 'white' : 'black';

        // Готуємо SQL-запит для пакетного виконання
        batchStatements.push(
          env.DB.prepare(`
            INSERT INTO channels (id, name, status, source, created_at, updated_at)
            VALUES (?, ?, ?, 'sheet_import', datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              name = CASE WHEN channels.name IS NULL OR channels.name = 'Pending...' THEN excluded.name ELSE channels.name END,
              updated_at = datetime('now')
          `).bind(channelId, initialName, statusValue)
        );
      }

      // Виконуємо записи порціями по 50 штук (щоб не перевищити лимиты Cloudflare)
      const CHUNK_SIZE = 50;
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
  // ЕТАП 2: Автоматичне оновлення метрик через YouTube API
  // -------------------------------------------------------------
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    result.errors.push({ step: "youtube_sync", error: "YOUTUBE_API_KEY secret is not set" });
    return result;
  }

  try {
    const { results: staleChannels } = await env.DB.prepare(
      `SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?`
    ).bind(BATCH_LIMIT).all();

    for (const { id } of staleChannels) {
      try {
        const stats = await fetchChannelStats(id, apiKey);
        if (!stats) continue;

        await env.DB.prepare(`
          UPDATE channels
          SET 
            name = COALESCE(NULLIF(?, ''), name),
            country = COALESCE(NULLIF(?, ''), country),
            language = COALESCE(NULLIF(?, ''), language),
            subscribers = ?, 
            avg_views_month = ?, 
            videos_month = ?, 
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          stats.name,
          stats.country,
          stats.language,
          stats.subscribers,
          stats.avgViewsMonth,
          stats.videosMonth,
          id
        ).run();

        result.ytUpdated++;
      } catch (e) {
        result.errors.push({ step: "youtube_sync", id, error: String(e) });
      }
    }
  } catch (e) {
    result.errors.push({ step: "youtube_sync_init", error: String(e) });
  }

  return result;
}

function parseChannelId(url) {
  if (!url) return null;
  const match = url.match(/channel\/([\w-]+)/) || url.match(/@([\w-]+)/);
  return match ? match[1] : null;
}

async function fetchChannelStats(channelId, apiKey) {
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
  );
  const chData = await chRes.json();
  const channel = chData.items?.[0];
  if (!channel) return null;

  const snippet = channel.snippet || {};
  const stats = channel.statistics || {};

  const name = snippet.title || '';
  const country = snippet.country || '';
  const language = snippet.defaultLanguage || snippet.audioLanguage || '';
  const subscribers = Number(stats.subscriberCount || 0);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}` +
    `&publishedAfter=${since}&type=video&order=date&maxResults=50&key=${apiKey}`
  );
  const searchData = await searchRes.json();
  const videoIds = (searchData.items || []).map(i => i.id?.videoId).filter(Boolean);

  if (videoIds.length === 0) {
    return { name, country, language, subscribers, avgViewsMonth: 0, videosMonth: 0 };
  }

  const videosRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
  );
  const videosData = await videosRes.json();
  const views = (videosData.items || []).map(v => Number(v.statistics?.viewCount || 0));
  const avgViewsMonth = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return { name, country, language, subscribers, avgViewsMonth, videosMonth: videoIds.length };
}
