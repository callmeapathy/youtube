import Papa from 'papaparse';

const BATCH_LIMIT = 40; // Сколько каналов обогащать метриками YouTube за один раз

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
  // ЭТАП 1: Загрузка / Пополнение базы из Google Sheets
  // -------------------------------------------------------------
  if (env.GOOGLE_SHEET_CSV_URL) {
    try {
      const sheetRes = await fetch(env.GOOGLE_SHEET_CSV_URL);
      const csvText = await sheetRes.text();

      const { data: rows } = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true
      });

      for (const row of rows) {
        // Достаем ссылку и название из колонок твоего файла
        const rawUrl = row['URL-адреса місця розташування'] || row['url'] || row['URL'];
        const exceptionTitle = row['Виключення'] || '';

        if (!rawUrl) continue;

        const channelId = parseChannelId(rawUrl);
        if (!channelId) continue;

        // Делаем UPSERT в таблицу channels
        await env.DB.prepare(`
          INSERT INTO channels (id, title, status, source, created_at, updated_at)
          VALUES (?, ?, 'black', 'sheet_import', datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            title = CASE WHEN channels.title IS NULL OR channels.title = '' THEN excluded.title ELSE channels.title END,
            updated_at = datetime('now')
        `).bind(channelId, exceptionTitle).run();

        result.sheetsImported++;
      }
    } catch (e) {
      result.errors.push({ step: "google_sheets_import", error: String(e) });
    }
  }

  // -------------------------------------------------------------
  // ЭТАП 2: Синк метрик с YouTube API (для старых записей)
  // -------------------------------------------------------------
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    result.errors.push({ step: "youtube_sync", error: "YOUTUBE_API_KEY secret is not set" });
    return result;
  }

  const { results: staleChannels } = await env.DB.prepare(
    `SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?`
  ).bind(BATCH_LIMIT).all();

  for (const { id } of staleChannels) {
    try {
      const stats = await fetchChannelStats(id, apiKey);
      if (!stats) continue;

      await env.DB.prepare(`
        UPDATE channels
        SET subscribers = ?, avg_views_m = ?, videos_mth = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(stats.subscribers, stats.avgViewsMonth, stats.videosMonth, id).run();

      result.ytUpdated++;
    } catch (e) {
      result.errors.push({ step: "youtube_sync", id, error: String(e) });
    }
  }

  return result;
}

// Извлечение ID канала из ссылки youtube.com/channel/UC...
function parseChannelId(url) {
  const match = url.match(/channel\/([\w-]+)/) || url.match(/@([\w-]+)/);
  return match ? match[1] : null;
}

// Запрос статистики канала из YouTube API v3
async function fetchChannelStats(channelId, apiKey) {
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
  );
  const chData = await chRes.json();
  const channel = chData.items?.[0];
  if (!channel) return null;

  const subscribers = Number(channel.statistics?.subscriberCount || 0);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}` +
    `&publishedAfter=${since}&type=video&order=date&maxResults=50&key=${apiKey}`
  );
  const searchData = await searchRes.json();
  const videoIds = (searchData.items || []).map(i => i.id?.videoId).filter(Boolean);

  if (videoIds.length === 0) {
    return { subscribers, avgViewsMonth: 0, videosMonth: 0 };
  }

  const videosRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
  );
  const videosData = await videosRes.json();
  const views = (videosData.items || []).map(v => Number(v.statistics?.viewCount || 0));
  const avgViewsMonth = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return { subscribers, avgViewsMonth, videosMonth: videoIds.length };
}
