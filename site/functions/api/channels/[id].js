// GET   /api/channels/:id  -> один канал
// PATCH /api/channels/:id  -> часткове оновлення, body: {quality?, status?}
// Кожна правка пишеться в rating_log — це майбутній тренувальний датасет.

export async function onRequestGet(context) {
  const { env, params } = context;
  const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?")
    .bind(params.id).first();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(row);
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const current = await env.DB.prepare("SELECT * FROM channels WHERE id = ?")
    .bind(params.id).first();
  if (!current) return Response.json({ error: "not_found" }, { status: 404 });

  const updates = [];
  const values = [];
  const logInserts = [];

  if (body.quality !== undefined && body.quality !== current.quality) {
    updates.push("quality = ?");
    values.push(body.quality);
    logInserts.push(["quality", String(current.quality), String(body.quality)]);
  }
  if (body.status !== undefined && body.status !== current.status) {
    updates.push("status = ?");
    values.push(body.status);
    logInserts.push(["status", current.status, body.status]);
  }

  if (updates.length === 0) {
    return Response.json({ ok: true, unchanged: true });
  }

  updates.push("updated_at = datetime('now')");
  values.push(params.id);

  await env.DB.prepare(`UPDATE channels SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values).run();

  for (const [field, oldV, newV] of logInserts) {
    await env.DB.prepare(
      "INSERT INTO rating_log (channel_id, field, old_value, new_value) VALUES (?,?,?,?)"
    ).bind(params.id, field, oldV, newV).run();
  }

  return Response.json({ ok: true });
}
