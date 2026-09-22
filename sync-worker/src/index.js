/**
 * YT Placements — sync worker.
 *
 * Дві незалежні фази за один запуск:
 *
 *  ФАЗА 1 — DISCOVER. Якщо задано env.GOOGLE_SHEET_CSV_URL, читаємо аркуш
 *  (він має бути опублікований як CSV: File → Share → Publish to web → CSV),
 *  дістаємо з нього посилання на канали + позначку white/black, і додаємо
 *  в D1 ті, яких там ще немає. Дорога частина тут — розпізнавання @handle
 *  в реальний channelId (1 юніт API за кожен), тому кількість нових рядків
 *  за прогін обмежена DISCOVER_LIMIT.
 *
 *  ФАЗА 2 — REFRESH. Для каналів, які вже є в базі (найстаріші за
 *  updated_at — першими), рахуємо чесні "середні перегляди за 30 днів"
 *  через search.list + videos.list. Це найдорожча частина (100 юнитів
 *  за search.list), тому кількість за прогін обмежена REFRESH_LIMIT.
 *
 * Квота YouTube Data API — 10 000 юнитів/добу:
 *   DISCOVER_LIMIT=25  → ~1-2 юніта на channels.list (батчами по 50)
 *                         + до 25 юнитів на резолв @handle
 *   REFRESH_LIMIT=40   → 40 × ~101 юніт (search.list + videos.list) ≈ 4040
 *   Разом ≈ 4100 юнитів за прогін — з запасом навіть якщо запускати
 *   вручну кілька разів на день поверх щоденного cron.
 */

const DISCOVER_LIMIT = 25;
const REFRESH_LIMIT = 40;

const TYPE_RULES = [
  { type: "Медіа", re: /новини|новости|тв|телеканал|радіо|радио|канал\s?24|студі[яю]|production|продакшн/i },
  { type: "Бренд", re: /офіційний|official|brand|бренд|store|shop/i },
  { type: "Мережа", re: /мультиканальна|network|мережа|агрегатор/i },
];

const CATEGORY_BY_TOPIC = {
  Gaming: "Ігри",
  Music: "Музика",
  Entertainment: "Розваги",
  Society: "Новини та політика",
  Lifestyle: "Лайфстайл / влоги",
  Technology: "Технології",
  Sport: "Спорт",
  Film: "Фільми та анімація",
  Knowledge: "Освіта",
  Food: "Їжа та кулінарія",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await runSync(env);
      return Response.json(result);
    }
    return new Response("YT Placements sync worker. GET /run to trigger manually.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};

async function runSync(env) {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { error: "YOUTUBE_API_KEY secret is not set" };
  }

  const report = { discover: null, refresh: null };

  if (env.GOOGLE_SHEET_CSV_URL) {
    report.discover = await discoverFromSheet(env, apiKey);
  } else {
    report.discover = { skipped: true, reason: "GOOGLE_SHEET_CSV_URL secret is not set" };
  }

  report.refresh = await refreshStaleChannels(env, apiKey);

  return report;
}

/* ---------------------------- ФАЗА 1: DISCOVER --------------------------- */

async function discoverFromSheet(env, apiKey) {
  const res = await fetch(env.GOOGLE_SHEET_CSV_URL);
  if (!res.ok) {
    return { error: `sheet fetch failed: HTTP ${res.status}` };
  }
  const csvText = await res.text();
  const rows = parseSheetRows(csvText);

  if (rows.length === 0) {
    return { foundInSheet: 0, newChannels: 0 };
  }

  // Які з цих каналів вже є в D1 — щоб не витрачати квоту на них повторно
  const { results: existing } = await env.DB.prepare("SELECT id FROM channels").all();
  const existingIds = new Set((existing || []).map((r) => r.id));

  const candidates = rows.filter((r) => !existingIds.has(r.ref)).slice(0, DISCOVER_LIMIT);
  if (candidates.length === 0) {
    return { foundInSheet: rows.length, newChannels: 0, note: "all rows already in DB" };
  }

  // @handle потрібно окремо резолвити в справжній channelId (1 юніт кожен)
  const resolved = [];
  for (const c of candidates) {
    if (c.refType === "id") {
      resolved.push({ id: c.ref, status: c.status });
    } else {
      const realId = await resolveHandle(c.ref, apiKey);
      if (realId) resolved.push({ id: realId, status: c.status });
    }
  }
  if (resolved.length === 0) {
    return { foundInSheet: rows.length, newChannels: 0, note: "nothing resolved to a real channel id" };
  }

  // channels.list батчами по 50 — дешево (1 юніт за виклик)
  const basics = await fetchChannelsBasics(resolved.map((r) => r.id), apiKey);
  const statusById = new Map(resolved.map((r) => [r.id, r.status]));

  let inserted = 0;
  for (const ch of basics) {
    await env.DB.prepare(`
      INSERT INTO channels (id, name, country, type, category, language, subscribers, status, source, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'sheet', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        subscribers = excluded.subscribers,
        updated_at = datetime('now')
    `).bind(
      ch.id, ch.name, ch.country, ch.type, ch.category, ch.language,
      ch.subscribers, statusById.get(ch.id) || ""
    ).run();
    inserted++;
  }

  return { foundInSheet: rows.length, candidates: candidates.length, newChannels: inserted };
}

/** Рядок Google Sheet → { ref, refType: 'id'|'handle', status }, або null якщо в рядку немає посилання на канал */
function parseSheetRows(csvText) {
  const lines = csvText.split(/\r?\n/).slice(1); // перший рядок — заголовки
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;

    const idMatch = line.match(/channel\/(UC[\w-]{22})/);
    const handleMatch = line.match(/@([\w.-]+)/);

    let ref = null, refType = null;
    if (idMatch) { ref = idMatch[1]; refType = "id"; }
    else if (handleMatch) { ref = "@" + handleMatch[1]; refType = "handle"; }
    if (!ref) continue;

    const lower = line.toLowerCase();
    const status = lower.includes("black") || lower.includes("чорн") ? "black"
                 : lower.includes("white") || lower.includes("біл")   ? "white"
                 : "";

    out.push({ ref, refType, status });
  }
  // дедуп в межах самого файлу
  const seen = new Set();
  return out.filter((r) => (seen.has(r.ref) ? false : (seen.add(r.ref), true)));
}

async function resolveHandle(handle, apiKey) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`
  );
  const data = await res.json();
  return data.items?.[0]?.id || null;
}

async function fetchChannelsBasics(ids, apiKey) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,topicDetails&id=${chunk.join(",")}&key=${apiKey}`
    );
    const data = await res.json();
    for (const item of data.items || []) {
      out.push({
        id: item.id,
        name: item.snippet?.title || item.id,
        country: item.snippet?.country || "XX",
        language: item.snippet?.defaultLanguage || "uk",
        subscribers: Number(item.statistics?.subscriberCount || 0),
        type: guessType(item.snippet?.title, item.snippet?.description),
        category: guessCategory(item.topicDetails),
      });
    }
  }
  return out;
}

function guessType(title = "", description = "") {
  const text = `${title} ${description}`;
  for (const rule of TYPE_RULES) if (rule.re.test(text)) return rule.type;
  return "Блогер";
}

function guessCategory(topicDetails) {
  const topics = topicDetails?.topicCategories || [];
  for (const url of topics) {
    for (const [key, label] of Object.entries(CATEGORY_BY_TOPIC)) {
      if (url.includes(key)) return label;
    }
  }
  return "";
}

/* ---------------------------- ФАЗА 2: REFRESH ----------------------------- */

async function refreshStaleChannels(env, apiKey) {
  const { results: stale } = await env.DB.prepare(
    "SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?"
  ).bind(REFRESH_LIMIT).all();

  if (!stale.length) {
    return { updated: 0, message: "no channels in DB yet" };
  }

  let updated = 0;
  const errors = [];

  for (const { id } of stale) {
    try {
      const stats = await fetchMonthlyStats(id, apiKey);
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

  return { updated, total: stale.length, errors };
}

async function fetchMonthlyStats(channelId, apiKey) {
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`
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
  const videoIds = (searchData.items || []).map((i) => i.id?.videoId).filter(Boolean);

  if (videoIds.length === 0) {
    return { subscribers, avgViewsMonth: 0, videosMonth: 0 };
  }

  const videosRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
  );
  const videosData = await videosRes.json();
  const views = (videosData.items || []).map((v) => Number(v.statistics?.viewCount || 0));
  const avgViewsMonth = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return { subscribers, avgViewsMonth, videosMonth: videoIds.length };
}
