import { Hono } from 'hono';
import { requireAuth, requireHR } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';

export const announcementRoutes = new Hono();
announcementRoutes.use('*', requireAuth);

function rowToAnnouncement(r) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    pinned: !!r.pinned,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// كل الموظفين وقائد الفريق يشوفوا كل الإعلانات — لوحة إعلانات داخلية واحدة.
announcementRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT * FROM hr_announcements ORDER BY pinned DESC, created_at DESC LIMIT 100`)
    .all();
  return c.json({ announcements: rows.results.map(rowToAnnouncement) });
});

// نشر إعلان جديد — قائد الفريق فقط.
announcementRoutes.post('/', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();
  if (!title) return jsonError(c, 400, 'عنوان الإعلان مطلوب', 'MISSING_TITLE');
  if (!text) return jsonError(c, 400, 'نص الإعلان مطلوب', 'MISSING_BODY');

  const inserted = await db
    .prepare(`INSERT INTO hr_announcements (title, body, pinned, created_by) VALUES (?, ?, ?, ?) RETURNING id`)
    .bind(title, text, body.pinned ? 1 : 0, user.id)
    .first();

  await logActivity(db, { actor: user, action: 'ANNOUNCEMENT_POSTED', entityType: 'announcement', entityId: String(inserted.id), metadata: { title } });
  await broadcast(c.env, 'ANNOUNCEMENT_POSTED', { announcementId: inserted.id }, { scope: 'all' });
  return c.json({ ok: true, announcementId: inserted.id });
});

// تعديل إعلان — قائد الفريق فقط.
announcementRoutes.patch('/:id', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM hr_announcements WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'الإعلان غير موجود', 'NOT_FOUND');

  const title = body.title !== undefined ? String(body.title).trim() : row.title;
  const text = body.body !== undefined ? String(body.body).trim() : row.body;
  if (!title) return jsonError(c, 400, 'عنوان الإعلان مطلوب', 'MISSING_TITLE');
  if (!text) return jsonError(c, 400, 'نص الإعلان مطلوب', 'MISSING_BODY');
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : row.pinned;

  await db.prepare(`UPDATE hr_announcements SET title=?, body=?, pinned=?, updated_at=? WHERE id=?`).bind(title, text, pinned, nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'ANNOUNCEMENT_UPDATED', entityType: 'announcement', entityId: String(id), metadata: {} });
  return c.json({ ok: true });
});

// حذف إعلان — قائد الفريق فقط.
announcementRoutes.delete('/:id', requireHR, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare(`SELECT * FROM hr_announcements WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'الإعلان غير موجود', 'NOT_FOUND');
  await db.prepare(`DELETE FROM hr_announcements WHERE id = ?`).bind(id).run();
  await logActivity(db, { actor: user, action: 'ANNOUNCEMENT_DELETED', entityType: 'announcement', entityId: String(id), metadata: { title: row.title } });
  return c.json({ ok: true });
});
