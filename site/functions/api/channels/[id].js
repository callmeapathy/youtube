export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = params.id;

  try {
    const data = await request.json();
    const updates = [];
    const values = [];

    // Читаем рейтинг из любого ключа, который пришлет фронтенд
    const ratingValue = data.rating !== undefined ? data.rating : data.quality;
    if (ratingValue !== undefined) {
      updates.push("quality = ?");
      values.push(Number(ratingValue));
    }

    // Читаем статус
    if (data.status !== undefined) {
      updates.push("status = ?");
      values.push(String(data.status));
    }

    // Читаем тип
    if (data.type !== undefined) {
      updates.push("type = ?");
      values.push(String(data.type));
    }

    // Читаем категорию
    if (data.category !== undefined) {
      updates.push("category = ?");
      values.push(String(data.category));
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update" }), { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    const sql = `UPDATE channels SET ${updates.join(", ")} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...values).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
