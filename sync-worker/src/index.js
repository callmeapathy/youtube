/**
 * YT Placements — sync worker.
 *
 * Дві незалежні фази за один запуск:
 *
 *  ФАЗА 1 — DISCOVER. Якщо задано env.GOOGLE_SHEET_CSV_URL, читаємо аркуш
 *  (він має бути опублікований як CSV: File → Share → Publish to web → CSV),
 *  дістаємо з нього посилання на канали + позначку white/black, і додаємо
 *  в D1 ті, яких там ще немає.
 *
 *  ФАЗА 2 — REFRESH. Для каналів, які вже є в базі (найстаріші за
 *  updated_at — першими), рахуємо чесні "середні перегляди за 30 днів"
 *  через search.list + videos.list.
 *
 * ГОЛОВНЕ ОБМЕЖЕННЯ ТУТ — не квота YouTube API (10 000 юнитів/добу, її
 * вистачає з великим запасом), а ліміт самого Cloudflare Workers на
 * безкоштовному тарифі: один виклик воркера може зробити максимум 50
 * зовнішніх запитів (subrequests) сумарно. Тому обидві фази рахують
 * запити в один спільний бюджет (SUBREQUEST_BUDGET) і зупиняються, не
 * долітаючи до ліміту — решта необроблених каналів просто чекають
 * наступного запуску (cron щодня, або ручний GET /run коли завгодно).
 */
const SUBREQUEST_BUDGET = 45; // залишаємо запас від жорсткого ліміту 50
const DISCOVER_BUDGET = 12;   // скільки з бюджету віддаємо під пошук нових каналів

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

  const budget = { used: 0, limit: SUBREQUEST_BUDGET };
  const report = { discover: null, refresh: null, subrequestBudget: SUBREQUEST_BUDGET };

  if (env.GOOGLE_SHEET_CSV_URL) {
    report.discover = await discoverFromSheet(env, apiKey, budget);
  } else {
    report.discover = { skipped: true, reason: "GOOGLE_SHEET_CSV_URL secret is not set" };
  }

  report.refresh = await refreshStaleChannels(env, apiKey, budget);
  report.subrequestsUsed = budget.used;

  return report;
}

/** fetch, що рахує сам себе в спільний бюджет. Повертає null, якщо бюджет вичерпано. */
async function trackedFetch(budget, url) {
  if (budget.used >= budget.limit) return null;
  budget.used++;
  return fetch(url);
}

/* ---------------------------- ФАЗА 1: DISCOVER --------------------------- */

async function discoverFromSheet(env, apiKey, budget) {
  const res = await fetch(env.GOOGLE_SHEET_CSV_URL); // сама таблиця не входить в бюджет YouTube API
  if (!res.ok) {
    return { error: `sheet fetch failed: HTTP ${res.status}` };
  }
  const csvText = await res.text();
  const rows = parseSheetRows(csvText);

  if (rows.length === 0) {
    return { foundInSheet: 0, newChannels: 0 };
  }

  const { results: existing } = await env.DB.prepare("SELECT id FROM channels").all();
  const existingIds = new Set((existing || []).map((r) => r.id));

  // Резервуємо частину спільного бюджету саме під discover, щоб refresh теж щось встиг
  const discoverBudget = Math.min(DISCOVER_BUDGET, budget.limit - budget.used);
  const candidates = rows.filter((r) => !existingIds.has(r.ref)).slice(0, discoverBudget);
  if (candidates.length === 0) {
    return { foundInSheet: rows.length, newChannels: 0, note: "all rows already in DB" };
  }

  const resolved = [];
  for (const c of candidates) {
    if (budget.used >= budget.limit) break;
    if (c.refType === "id") {
      resolved.push({ id: c.ref, status: c.status });
    } else {
      const realId = await resolveHandle(c.ref, apiKey, budget);
      if (realId) resolved.push({ id: realId, status: c.status });
    }
  }
  if (resolved.length === 0) {
    return { foundInSheet: rows.length, newChannels: 0, note: "nothing resolved (or budget ran out)" };
  }

  const basics = await fetchChannelsBasics(resolved.map((r) => r.id), apiKey, budget);
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

async function resolveHandle(handle, apiKey, budget) {
  const res = await trackedFetch(budget,
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`
  );
  if (!res) return null;
  const data = await res.json();
  return data.items?.[0]?.id || null;
}

async function fetchChannelsBasics(ids, apiKey, budget) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    if (budget.used >= budget.limit) break;
    const chunk = ids.slice(i, i + 50);
    const res = await trackedFetch(budget,
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,topicDetails&id=${chunk.join(",")}&key=${apiKey}`
    );
    if (!res) break;
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

async function refreshStaleChannels(env, apiKey, budget) {
  const remaining = budget.limit - budget.used;
  const COST_PER_CHANNEL = 3; // channels.list + search.list + videos.list
  const affordable = Math.max(0, Math.floor(remaining / COST_PER_CHANNEL));

  if (affordable === 0) {
    return { updated: 0, skipped: true, reason: "subrequest budget exhausted by discover phase" };
  }

  const { results: stale } = await env.DB.prepare(
    "SELECT id FROM channels ORDER BY updated_at ASC LIMIT ?"
  ).bind(affordable).all();

  if (!stale.length) {
    return { updated: 0, message: "no channels in DB yet" };
  }

  let updated = 0;
  const errors = [];

  for (const { id } of stale) {
    if (budget.limit - budget.used < COST_PER_CHANNEL) break; // не почнемо канал, який не докінчимо
    try {
      const stats = await fetchMonthlyStats(id, apiKey, budget);
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

async function fetchMonthlyStats(channelId, apiKey, budget) {
  const chRes = await trackedFetch(budget,
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`
  );
  if (!chRes) return null;
  const chData = await chRes.json();
  const channel = chData.items?.[0];
  if (!channel) return null;
  const subscribers = Number(channel.statistics?.subscriberCount || 0);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const searchRes = await trackedFetch(budget,
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}` +
    `&publishedAfter=${since}&type=video&order=date&maxResults=50&key=${apiKey}`
  );
  if (!searchRes) return { subscribers, avgViewsMonth: 0, videosMonth: 0 };
  const searchData = await searchRes.json();
  const videoIds = (searchData.items || []).map((i) => i.id?.videoId).filter(Boolean);

  if (videoIds.length === 0) {
    return { subscribers, avgViewsMonth: 0, videosMonth: 0 };
  }

  const videosRes = await trackedFetch(budget,
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${apiKey}`
  );
  if (!videosRes) return { subscribers, avgViewsMonth: 0, videosMonth: videoIds.length };
  const videosData = await videosRes.json();
  const views = (videosData.items || []).map((v) => Number(v.statistics?.viewCount || 0));
  const avgViewsMonth = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

  return { subscribers, avgViewsMonth, videosMonth: videoIds.length };
}
