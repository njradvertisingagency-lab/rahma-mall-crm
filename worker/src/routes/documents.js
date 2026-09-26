import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const documentRoutes = new Hono();
documentRoutes.use('*', requireAuth);

const DOC_TYPES = ['CONTRACT', 'ID_COPY', 'CERTIFICATE', 'CV', 'OTHER'];

function rowToDocument(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNameAr: r.employee_name_ar,
    docType: r.doc_type,
    title: r.title,
    externalUrl: r.external_url,
    issueDate: r.issue_date,
    expiryDate: r.expiry_date,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// قائمة المستندات — قائد الفريق يرى الكل، الموظف يرى مستنداته فقط.
documentRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const conds = [];
  const binds = [];
  if (user.role === 'employee') {
    conds.push('d.employee_id = ?');
    binds.push(user.employeeId);
  } else if (c.req.query('employeeId')) {
    conds.push('d.employee_id = ?');
    binds.push(Number(c.req.query('employeeId')));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db
    .prepare(
      `SELECT d.*, e.name AS employee_name, e.name_ar AS employee_name_ar
       FROM employee_documents d JOIN employees e ON e.id = d.employee_id
       ${where} ORDER BY d.created_at DESC LIMIT 200`
    )
    .bind(...binds)
    .all();
  return c.json({ documents: rows.results.map(rowToDocument) });
});

// إضافة مستند/عقد جديد — قائد الفريق فقط. الرابط رابط خارجي (Google Drive
// مثلاً) — النظام لا يخزن أي ملفات فعلية، فقط بيانات وصفية + رابط.
documentRoutes.post('/', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const employeeId = Number(body.employeeId);
  if (!employeeId) return jsonError(c, 400, 'الموظف غير محدد', 'MISSING_EMPLOYEE');
  const docType = String(body.docType || '');
  if (!DOC_TYPES.includes(docType)) return jsonError(c, 400, 'نوع المستند غير صالح', 'INVALID_TYPE');
  const title = String(body.title || '').trim();
  if (!title) return jsonError(c, 400, 'عنوان المستند مطلوب', 'MISSING_TITLE');

  const emp = await db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(employeeId).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const inserted = await db
    .prepare(
      `INSERT INTO employee_documents (employee_id, doc_type, title, external_url, issue_date, expiry_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(
      employeeId,
      docType,
      title,
      body.externalUrl ? String(body.externalUrl).trim() : null,
      body.issueDate || null,
      body.expiryDate || null,
      body.notes ? String(body.notes).trim() : null,
      user.id
    )
    .first();

  await logActivity(db, { actor: user, action: 'DOCUMENT_ADDED', entityType: 'employee', entityId: String(employeeId), metadata: { docType, title } });
  return c.json({ ok: true, documentId: inserted.id });
});

// تعديل مستند — قائد الفريق فقط.
documentRoutes.patch('/:id', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const row = await db.prepare(`SELECT * FROM employee_documents WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'المستند غير موجود', 'NOT_FOUND');

  const title = body.title !== undefined ? String(body.title).trim() : row.title;
  if (!title) return jsonError(c, 400, 'عنوان المستند مطلوب', 'MISSING_TITLE');

  await db
    .prepare(`UPDATE employee_documents SET title=?, external_url=?, issue_date=?, expiry_date=?, notes=?, updated_at=? WHERE id=?`)
    .bind(
      title,
      body.externalUrl !== undefined ? (body.externalUrl ? String(body.externalUrl).trim() : null) : row.external_url,
      body.issueDate !== undefined ? body.issueDate : row.issue_date,
      body.expiryDate !== undefined ? body.expiryDate : row.expiry_date,
      body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : row.notes,
      nowIso(),
      id
    )
    .run();
  await logActivity(db, { actor: user, action: 'DOCUMENT_UPDATED', entityType: 'employee', entityId: String(row.employee_id), metadata: { documentId: id } });
  return c.json({ ok: true });
});

// حذف مستند — قائد الفريق فقط.
documentRoutes.delete('/:id', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare(`SELECT * FROM employee_documents WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 404, 'المستند غير موجود', 'NOT_FOUND');
  await db.prepare(`DELETE FROM employee_documents WHERE id = ?`).bind(id).run();
  await logActivity(db, { actor: user, action: 'DOCUMENT_DELETED', entityType: 'employee', entityId: String(row.employee_id), metadata: { documentId: id, title: row.title } });
  return c.json({ ok: true });
});
