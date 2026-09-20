import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';

export const savedFilterRoutes = new Hono();
savedFilterRoutes.use('*', requireAuth);

savedFilterRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(`SELECT id, name, query, created_at FROM saved_filters WHERE user_id = ? ORDER BY created_at DESC`).bind(user.id).all();
  return c.json({ filters: rows.results.map((r) => ({ ...r, query: JSON.parse(r.query) })) });
});

savedFilterRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return jsonError(c, 400, 'اسم الفلتر مطلوب', 'MISSING_NAME');
  if (!body.query || typeof body.query !== 'object') return jsonError(c, 400, 'معايير الفلتر مطلوبة', 'MISSING_QUERY');

  const existing = await db.prepare(`SELECT id FROM saved_filters WHERE user_id = ? AND name = ?`).bind(user.id, name).first();
  if (existing) {
    await db.prepare(`UPDATE saved_filters SET query = ? WHERE id = ?`).bind(JSON.stringify(body.query), existing.id).run();
    return c.json({ filter: { id: existing.id, name, query: body.query } });
  }
  const res = await db.prepare(`INSERT INTO saved_filters (user_id, name, query) VALUES (?, ?, ?) RETURNING id, created_at`).bind(user.id, name, JSON.stringify(body.query)).first();
  return c.json({ filter: { id: res.id, name, query: body.query, created_at: res.created_at } }, 201);
});

savedFilterRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const existing = await db.prepare(`SELECT id FROM saved_filters WHERE id = ? AND user_id = ?`).bind(id, user.id).first();
  if (!existing) return jsonError(c, 404, 'الفلتر غير موجود', 'NOT_FOUND');
  await db.prepare(`DELETE FROM saved_filters WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});
