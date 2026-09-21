// GET  /api/channels        -> список усіх каналів
// POST /api/channels        -> додати/оновити канал (upsert), body: повний об'єкт каналу

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB
    .prepare("SELECT * FROM channels ORDER BY avg_views_month DESC")
    .all();
  return Response.json(results);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const {
    id, name, country = "XX", type = "", category = "", language = "",
    subscribers = 0, avg_views_month = 0, videos_month = 0,
    quality = 3, status = "", source = "manual"
  } = body;

  if (!id || !name) {
    return Response.json({ error: "id_and_name_required" }, { status: 400 });
  }

  await env.DB.prepare(`
    INSERT INTO channels (id,name,country,type,category,language,subscribers,avg_views_month,videos_month,quality,status,source,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, country=excluded.country, type=excluded.type,
      category=excluded.category, language=excluded.language,
      subscribers=excluded.subscribers, avg_views_month=excluded.avg_views_month,
      videos_month=excluded.videos_month, source=excluded.source,
      updated_at=datetime('now')
  `).bind(id, name, country, type, category, language, subscribers, avg_views_month, videos_month, quality, status, source).run();

  return Response.json({ ok: true, id });
}
