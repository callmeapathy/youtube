/**
 * Щоденний синк статистики каналів з YouTube Data API.
 *
 * ВАЖЛИВО про квоту: у YouTube Data API денна квота 10 000 юнитів.
 * channels.list коштує 1 юніт за запит (до 50 ID за раз) — дешево.
 * search.list коштує 100 юнитів за запит — дорого. Тому "середні перегляди
 * за місяць" тут рахуються ЧЕСНО (через видео за останні 30 днів), але
 * лише для обмеженої кількості каналів за один прогін (BATCH_LIMIT),
 * щоб не спалити всю денну квоту одним запуском.
 *
 * Цей воркер лише ОНОВЛЮЄ канали, які вже є в D1 (додані вручну через
 * POST /api/channels або через seed.sql). Пошук нових каналів — окрема
 * задача, яку додамо, коли визначимось із джерелом (Google Ads placement
 * report / Google Sheet).
 */

const BATCH_LIMIT = 40; // скільки каналів оновлювати за один запуск cron

export default {
  async fetch(request, env) {
    // Ручний запуск для тестування: GET /run
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await syncChannels(env);
      return Response.json(result);
    }
    return new Response("YT Placements sync worker. POST /run to trigger manually.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncChannels(env));
  },
};

async function syncChannels(env) {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { error: "YOUTUBE_API_KEY secret is not set" };
  }

  const { results: staleChannels } = await env.DB.prepare(
    `SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?`
  ).bind(BATCH_LIMIT).all();

  if (!staleChannels.length) {
    return { updated: 0, message: "no channels in DB yet — seed some first" };
  }

  let updated = 0;
  const errors = [];

  for (const { id } of staleChannels) {
    try {
      const stats = await fetchChannelStats(id, apiKey);
      if (!stats) continue;

      await env.DB.prepare(`
        UPDATE channels
        SET subscribers = ?, avg_views_month = ?, videos_month = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(stats.subscribers, stats.avgViewsMonth, stats.videosMonth, id).run();

      updated++;
    } catch (e) {
      errors.push({ id, error: String(e) });
    }
  }

  return { updated, total: staleChannels.length, errors };
}

async function fetchChannelStats(channelId, apiKey) {
  // 1 юніт: базова статистика каналу
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
  );
  const chData = await chRes.json();
  const channel = chData.items?.[0];
  if (!channel) return null;

  const subscribers = Number(channel.statistics?.subscriberCount || 0);

  // 100 юнитів: пошук відео за останні 30 днів (найдорожча частина)
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

  // 1 юніт: перегляди по знайдених відео
  const videosRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
  );
  const videosData = await videosRes.json();
  const views = (videosData.items || []).map(v => Number(v.statistics?.viewCount || 0));
  const avgViewsMonth = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return { subscribers, avgViewsMonth, videosMonth: videoIds.length };
}
