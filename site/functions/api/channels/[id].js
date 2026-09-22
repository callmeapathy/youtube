// GET   /api/channels/:id  -> один канал
// PATCH /api/channels/:id  -> часткове оновлення, body: {quality? | rating?, status?, type?, category?}
//
// quality та status пишуться в rating_log — це майбутній тренувальний
// датасет для власної моделі (порівняння "що поставив автомат" vs "що
// виправила людина"). type/category можна редагувати вручну, але вони
// НЕ логуються — це довідкові поля, не оцінка якості.

export async function onRequestGet(context) {
  const { env, params } = context;
  const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?")
    .bind(params.id).first();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(row);
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const current = await env.DB.prepare("SELECT * FROM channels WHERE id = ?")
    .bind(id).first();
  if (!current) return Response.json({ error: "not_found" }, { status: 404 });

  const updates = [];
  const values = [];
  const logInserts = [];

  // 'rating' приймаємо як синонім 'quality', щоб фронтенд міг слати будь-яке з двох
  const newQuality = body.quality !== undefined ? body.quality
                    : body.rating !== undefined ? body.rating
                    : undefined;

  if (newQuality !== undefined && Number(newQuality) !== current.quality) {
    updates.push("quality = ?");
    values.push(Number(newQuality));
    logInserts.push(["quality", String(current.quality), String(newQuality)]);
  }
  if (body.status !== undefined && body.status !== current.status) {
    updates.push("status = ?");
    values.push(String(body.status));
    logInserts.push(["status", current.status, String(body.status)]);
  }
  if (body.type !== undefined && body.type !== current.type) {
    updates.push("type = ?");
    values.push(String(body.type));
  }
  if (body.category !== undefined && body.category !== current.category) {
    updates.push("category = ?");
    values.push(String(body.category));
  }

  if (updates.length === 0) {
    return Response.json({ ok: true, unchanged: true });
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await env.DB.prepare(`UPDATE channels SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values).run();

  for (const [field, oldV, newV] of logInserts) {
    await env.DB.prepare(
      "INSERT INTO rating_log (channel_id, field, old_value, new_value) VALUES (?,?,?,?)"
    ).bind(id, field, oldV, newV).run();
  }

  return Response.json({ ok: true });
}
