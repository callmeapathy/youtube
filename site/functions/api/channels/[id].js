export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = params.id;

  try {
    const data = await request.json();
    const updates = [];
    const values = [];

    // 1. Оценка качества (в базе колонка называется quality)
    if (data.rating !== undefined) {
      updates.push("quality = ?");
      values.push(data.rating);
    } else if (data.quality !== undefined) {
      updates.push("quality = ?");
      values.push(data.quality);
    }

    // 2. Статус (white / black / new)
    if (data.status !== undefined) {
      updates.push("status = ?");
      values.push(data.status);
    }

    // 3. Тип канала
    if (data.type !== undefined) {
      updates.push("type = ?");
      values.push(data.type);
    }

    // 4. Категория
    if (data.category !== undefined) {
      updates.push("category = ?");
      values.push(data.category);
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update" }), { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    const sql = `UPDATE channels SET ${updates.join(", ")} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...values).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
