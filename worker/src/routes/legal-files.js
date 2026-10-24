import { Hono } from 'hono';
import { requireAuth, requireLegalOrHR } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const legalFileRoutes = new Hono();
legalFileRoutes.use('*', requireAuth, requireLegalOrHR);

// الحد الأقصى لعدد المستندات لكل ملف
const MAX_DOCS_PER_FILE = 20;
// الحد الأقصى لحجم المستند الواحد (5 MB as base64 ≈ 6.67 MB text)
const MAX_DOC_SIZE_BYTES = 5 * 1024 * 1024;

// ── Helpers ──────────────────────────────────────────────────────────
function userSection(user) {
  if (user.isLegal) return 'LEGAL';
  return 'HR';
}

async function recordHistory(db, { fileId, action, details, userId }) {
  await db
    .prepare(`INSERT INTO legal_file_history (file_id, action, details, performed_by, performed_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(fileId, action, details ? JSON.stringify(details) : null, userId, nowIso())
    .run();
}

// =====================================================================
// قائمة الملفات — مع فلتر حسب القسم والحالة
// =====================================================================
legalFileRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const section = c.req.query('section'); // HR | LEGAL | null (all)
  const status = c.req.query('status') || 'ACTIVE';
  const search = c.req.query('q')?.trim();
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
  const offset = (page - 1) * limit;

  let where = 'WHERE status = ?';
  const binds = [status];

  if (section && ['HR', 'LEGAL'].includes(section)) {
    where += ' AND current_section = ?';
    binds.push(section);
  }
  if (search) {
    where += ' AND (file_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR guarantor_name LIKE ? OR sales_name LIKE ?)';
    const q = `%${search}%`;
    binds.push(q, q, q, q, q);
  }

  const [countRow, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM legal_files ${where}`).bind(...binds).first(),
    db.prepare(`SELECT id, file_number, customer_name, customer_phone, guarantor_name, guarantor_phone, sales_name, current_section, status, notes, created_by, created_at, updated_at FROM legal_files ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all(),
  ]);

  return c.json({
    files: rows.results,
    total: countRow.total,
    page,
    limit,
    pages: Math.ceil(countRow.total / limit),
  });
});

// =====================================================================
// إحصائيات سريعة (عدد الملفات في كل قسم + طلبات معلقة)
// — يجب أن تكون قبل /:id لأن Hono يطابق أول مسار ينطبق
// =====================================================================
legalFileRoutes.get('/stats/summary', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const mySection = userSection(user);

  const [hrCount, legalCount, archivedCount, pendingIncoming, pendingOutgoing] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS cnt FROM legal_files WHERE current_section = 'HR' AND status = 'ACTIVE'`).first(),
    db.prepare(`SELECT COUNT(*) AS cnt FROM legal_files WHERE current_section = 'LEGAL' AND status = 'ACTIVE'`).first(),
    db.prepare(`SELECT COUNT(*) AS cnt FROM legal_files WHERE status = 'ARCHIVED'`).first(),
    db.prepare(`SELECT COUNT(*) AS cnt FROM legal_file_transfers WHERE from_section = ? AND status = 'PENDING'`).bind(mySection).first(),
    db.prepare(`SELECT COUNT(*) AS cnt FROM legal_file_transfers WHERE to_section = ? AND status = 'PENDING'`).bind(mySection).first(),
  ]);

  return c.json({
    hrFiles: hrCount.cnt,
    legalFiles: legalCount.cnt,
    archivedFiles: archivedCount.cnt,
    pendingIncoming: pendingIncoming.cnt,
    pendingOutgoing: pendingOutgoing.cnt,
  });
});

// =====================================================================
// قائمة طلبات النقل (الواردة لي)
// =====================================================================
legalFileRoutes.get('/transfers/pending', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const mySection = userSection(user);

  const rows = (await db.prepare(
    `SELECT t.*, f.file_number, f.customer_name, f.customer_phone
     FROM legal_file_transfers t
     JOIN legal_files f ON f.id = t.file_id
     WHERE t.from_section = ? AND t.status = 'PENDING'
     ORDER BY t.requested_at DESC`
  ).bind(mySection).all()).results;

  return c.json({ transfers: rows });
});

// =====================================================================
// قائمة طلبات النقل الصادرة مني
// =====================================================================
legalFileRoutes.get('/transfers/sent', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  const rows = (await db.prepare(
    `SELECT t.*, f.file_number, f.customer_name, f.customer_phone
     FROM legal_file_transfers t
     JOIN legal_files f ON f.id = t.file_id
     WHERE t.requested_by = ?
     ORDER BY t.requested_at DESC
     LIMIT 50`
  ).bind(user.id).all()).results;

  return c.json({ transfers: rows });
});

// =====================================================================
// الرد على طلب نقل (موافقة / رفض)
// =====================================================================
legalFileRoutes.patch('/transfers/:transferId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const transferId = Number(c.req.param('transferId'));
  if (!transferId || isNaN(transferId)) return jsonError(c, 400, 'معرف الطلب غير صحيح', 'INVALID_ID');
  const body = await c.req.json().catch(() => ({}));
  const decision = String(body.decision || '').toUpperCase();

  if (!['APPROVED', 'REJECTED'].includes(decision)) return jsonError(c, 400, 'القرار يجب أن يكون APPROVED أو REJECTED', 'INVALID_DECISION');

  const transfer = await db.prepare(`SELECT * FROM legal_file_transfers WHERE id = ? AND status = 'PENDING'`).bind(transferId).first();
  if (!transfer) return jsonError(c, 404, 'الطلب غير موجود أو تمت معالجته', 'NOT_FOUND');

  // فقط صاحب القسم المصدر يقدر يوافق أو يرفض — الطلب عبارة عن "أنا عايز الملف ده" من القسم التاني،
  // فالمقبول/المرفوض هو القسم اللي فيه الملف حاليًا (from_section)
  const mySection = userSection(user);
  if (transfer.from_section !== mySection) return jsonError(c, 403, 'ليس لديك صلاحية للرد على هذا الطلب', 'FORBIDDEN');

  const now = nowIso();
  await db.prepare(`UPDATE legal_file_transfers SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?`).bind(decision, user.id, now, transferId).run();

  if (decision === 'APPROVED') {
    await db.prepare(`UPDATE legal_files SET current_section = ?, updated_at = ? WHERE id = ?`).bind(transfer.to_section, now, transfer.file_id).run();
    await recordHistory(db, {
      fileId: transfer.file_id,
      action: 'TRANSFER_APPROVED',
      details: { transferId, from: transfer.from_section, to: transfer.to_section },
      userId: user.id,
    });
  } else {
    await recordHistory(db, {
      fileId: transfer.file_id,
      action: 'TRANSFER_REJECTED',
      details: { transferId, from: transfer.from_section, to: transfer.to_section },
      userId: user.id,
    });
  }

  return c.json({ ok: true, decision });
});

// =====================================================================
// تفاصيل ملف واحد + مستنداته
// =====================================================================
legalFileRoutes.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const file = await db.prepare(`SELECT * FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'NOT_FOUND');

  // المستندات — بدون data (ثقيلى)، تتحمّل واحدة واحدة
  const docs = (await db.prepare(`SELECT id, filename, content_type, file_size, uploaded_by, uploaded_at FROM legal_file_documents WHERE file_id = ? ORDER BY uploaded_at`).bind(id).all()).results;

  return c.json({ file, documents: docs });
});

// =====================================================================
// تحميل مستند واحد (البيانات الفعلية)
// =====================================================================
legalFileRoutes.get('/:id/documents/:docId', async (c) => {
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));
  const docId = Number(c.req.param('docId'));
  const doc = await db.prepare(`SELECT * FROM legal_file_documents WHERE id = ? AND file_id = ?`).bind(docId, fileId).first();
  if (!doc) return jsonError(c, 404, 'المستند غير موجود', 'DOC_NOT_FOUND');
  return c.json({ document: doc });
});

// =====================================================================
// إنشاء ملف جديد
// =====================================================================
legalFileRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const fileNumber = String(body.fileNumber || '').trim();
  const customerName = String(body.customerName || '').trim();
  const customerPhone = String(body.customerPhone || '').trim();
  const guarantorName = String(body.guarantorName || '').trim() || null;
  const guarantorPhone = String(body.guarantorPhone || '').trim() || null;
  const salesName = String(body.salesName || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;

  if (!fileNumber) return jsonError(c, 400, 'رقم الملف مطلوب', 'MISSING_FILE_NUMBER');
  if (!customerName) return jsonError(c, 400, 'اسم العميل مطلوب', 'MISSING_CUSTOMER_NAME');
  if (!customerPhone) return jsonError(c, 400, 'رقم هاتف العميل مطلوب', 'MISSING_CUSTOMER_PHONE');

  // تحقق من عدم تكرار رقم الملف
  const existing = await db.prepare(`SELECT id FROM legal_files WHERE file_number = ?`).bind(fileNumber).first();
  if (existing) return jsonError(c, 409, 'رقم الملف موجود بالفعل', 'DUPLICATE_FILE_NUMBER');

  const now = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO legal_files (file_number, customer_name, customer_phone, guarantor_name, guarantor_phone, sales_name, current_section, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'HR', 'ACTIVE', ?, ?, ?, ?)`
    )
    .bind(fileNumber, customerName, customerPhone, guarantorName, guarantorPhone, salesName, notes, user.id, now, now)
    .run();

  const fileId = result.meta.last_row_id;
  await recordHistory(db, { fileId, action: 'CREATED', details: { fileNumber, customerName, customerPhone, guarantorName, guarantorPhone, salesName }, userId: user.id });
  await logActivity(db, { actor: user, action: 'LEGAL_FILE_CREATED', entityType: 'legal_file', entityId: String(fileId), metadata: { fileNumber } });

  return c.json({ id: fileId, fileNumber }, 201);
});

// =====================================================================
// تعديل بيانات الملف
// =====================================================================
legalFileRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const file = await db.prepare(`SELECT * FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود أو مؤرشف', 'NOT_FOUND');

  const changes = {};
  const sets = [];
  const binds = [];

  const fields = [
    ['fileNumber', 'file_number'],
    ['customerName', 'customer_name'],
    ['customerPhone', 'customer_phone'],
    ['guarantorName', 'guarantor_name'],
    ['guarantorPhone', 'guarantor_phone'],
    ['salesName', 'sales_name'],
    ['notes', 'notes'],
  ];

  for (const [jsonKey, dbCol] of fields) {
    if (body[jsonKey] !== undefined) {
      const val = String(body[jsonKey] || '').trim() || null;
      if (val !== file[dbCol]) {
        changes[dbCol] = { from: file[dbCol], to: val };
        sets.push(`${dbCol} = ?`);
        binds.push(val);
      }
    }
  }

  if (sets.length === 0) return c.json({ ok: true, message: 'لا توجد تغييرات' });

  // لو غيّر رقم الملف، نتأكد مش مكرر
  if (changes.file_number) {
    const dup = await db.prepare(`SELECT id FROM legal_files WHERE file_number = ? AND id != ?`).bind(changes.file_number.to, id).first();
    if (dup) return jsonError(c, 409, 'رقم الملف موجود بالفعل', 'DUPLICATE_FILE_NUMBER');
  }

  sets.push('updated_at = ?');
  binds.push(nowIso());
  binds.push(id);

  await db.prepare(`UPDATE legal_files SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await recordHistory(db, { fileId: id, action: 'EDITED', details: changes, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// أرشفة ملف (لا حذف نهائي)
// =====================================================================
legalFileRoutes.patch('/:id/archive', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'NOT_FOUND');
  if (file.status === 'ARCHIVED') return jsonError(c, 400, 'الملف مؤرشف بالفعل', 'ALREADY_ARCHIVED');

  await db.prepare(`UPDATE legal_files SET status = 'ARCHIVED', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await recordHistory(db, { fileId: id, action: 'ARCHIVED', details: null, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// استعادة ملف من الأرشيف
// =====================================================================
legalFileRoutes.patch('/:id/restore', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'NOT_FOUND');
  if (file.status !== 'ARCHIVED') return jsonError(c, 400, 'الملف ليس مؤرشفًا', 'NOT_ARCHIVED');

  await db.prepare(`UPDATE legal_files SET status = 'ACTIVE', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await recordHistory(db, { fileId: id, action: 'RESTORED', details: null, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// رفع مستند (صورة / PDF) — base64
// =====================================================================
legalFileRoutes.post('/:id/documents', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود أو مؤرشف', 'NOT_FOUND');

  // التحقق من الحد الأقصى
  const countRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM legal_file_documents WHERE file_id = ?`).bind(id).first();
  if (countRow.cnt >= MAX_DOCS_PER_FILE) return jsonError(c, 400, `الحد الأقصى ${MAX_DOCS_PER_FILE} مستند لكل ملف`, 'MAX_DOCS_REACHED');

  const body = await c.req.json().catch(() => ({}));
  const filename = String(body.filename || '').trim();
  const contentType = String(body.contentType || '').trim();
  const data = String(body.data || '');

  if (!filename) return jsonError(c, 400, 'اسم الملف مطلوب', 'MISSING_FILENAME');
  if (!contentType) return jsonError(c, 400, 'نوع الملف مطلوب', 'MISSING_CONTENT_TYPE');
  if (!data) return jsonError(c, 400, 'بيانات الملف مطلوبة', 'MISSING_DATA');

  // Accept any image format + PDF
  if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
    return jsonError(c, 400, 'نوع الملف غير مدعوم — صور أو PDF فقط', 'INVALID_CONTENT_TYPE');
  }

  // تحقق من الحجم (base64 ≈ 1.33x)
  const rawSize = Math.ceil((data.length * 3) / 4);
  if (rawSize > MAX_DOC_SIZE_BYTES) return jsonError(c, 400, 'حجم الملف أكبر من 5 ميجا', 'FILE_TOO_LARGE');

  // عدد المستندات المتبقية بعد هذا الرفع
  const remaining = MAX_DOCS_PER_FILE - countRow.cnt - 1;

  const result = await db
    .prepare(`INSERT INTO legal_file_documents (file_id, filename, content_type, data, file_size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, filename, contentType, data, rawSize, user.id, nowIso())
    .run();

  await db.prepare(`UPDATE legal_files SET updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await recordHistory(db, { fileId: id, action: 'DOCUMENT_ADDED', details: { docId: result.meta.last_row_id, filename, contentType, size: rawSize }, userId: user.id });

  return c.json({ docId: result.meta.last_row_id, remaining }, 201);
});

// =====================================================================
// حذف مستند (soft — لا نحذف فعليًا من DB، بس نسجل في التاريخ)
// في الواقع هنحذفه لأن الـ data كبيرة، لكن التاريخ يبقى
// =====================================================================
legalFileRoutes.delete('/:id/documents/:docId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));
  const docId = Number(c.req.param('docId'));

  const doc = await db.prepare(`SELECT id, filename FROM legal_file_documents WHERE id = ? AND file_id = ?`).bind(docId, fileId).first();
  if (!doc) return jsonError(c, 404, 'المستند غير موجود', 'DOC_NOT_FOUND');

  await db.prepare(`DELETE FROM legal_file_documents WHERE id = ?`).bind(docId).run();
  await db.prepare(`UPDATE legal_files SET updated_at = ? WHERE id = ?`).bind(nowIso(), fileId).run();
  await recordHistory(db, { fileId, action: 'DOCUMENT_REMOVED', details: { docId, filename: doc.filename }, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// نقل ملف مباشر (HR ↔ LEGAL) — بدون طلب
// =====================================================================
legalFileRoutes.patch('/:id/move', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const toSection = String(body.toSection || '').toUpperCase();

  if (!['HR', 'LEGAL'].includes(toSection)) return jsonError(c, 400, 'القسم المطلوب غير صحيح', 'INVALID_SECTION');

  const file = await db.prepare(`SELECT id, current_section, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود أو مؤرشف', 'NOT_FOUND');
  if (file.current_section === toSection) return jsonError(c, 400, 'الملف موجود بالفعل في هذا القسم', 'SAME_SECTION');

  await db.prepare(`UPDATE legal_files SET current_section = ?, updated_at = ? WHERE id = ?`).bind(toSection, nowIso(), id).run();
  await recordHistory(db, {
    fileId: id,
    action: toSection === 'LEGAL' ? 'MOVED_TO_LEGAL' : 'MOVED_TO_HR',
    details: { from: file.current_section, to: toSection },
    userId: user.id,
  });

  return c.json({ ok: true });
});

// =====================================================================
// إنشاء طلب نقل
// =====================================================================
legalFileRoutes.post('/:id/transfer-request', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || '').trim() || null;

  const file = await db.prepare(`SELECT id, current_section, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود أو مؤرشف', 'NOT_FOUND');

  // الطرف المقابل
  const mySection = userSection(user);
  const fromSection = file.current_section;
  const toSection = mySection; // أنا عايز الملف يجيلي

  if (fromSection === toSection) return jsonError(c, 400, 'الملف موجود عندك بالفعل', 'FILE_ALREADY_HERE');

  // تحقق مفيش طلب معلق بالفعل
  const pending = await db.prepare(`SELECT id FROM legal_file_transfers WHERE file_id = ? AND status = 'PENDING'`).bind(id).first();
  if (pending) return jsonError(c, 409, 'يوجد طلب نقل معلق بالفعل لهذا الملف', 'PENDING_EXISTS');

  const result = await db
    .prepare(`INSERT INTO legal_file_transfers (file_id, from_section, to_section, note, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, fromSection, toSection, note, user.id, nowIso())
    .run();

  await recordHistory(db, { fileId: id, action: 'TRANSFER_REQUESTED', details: { transferId: result.meta.last_row_id, from: fromSection, to: toSection, note }, userId: user.id });

  return c.json({ transferId: result.meta.last_row_id }, 201);
});

// =====================================================================
// تاريخ ملف واحد
// =====================================================================
legalFileRoutes.get('/:id/history', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'الملف غير موجود', 'NOT_FOUND');

  const rows = (await db.prepare(
    `SELECT h.*, u.display_name AS performer_name
     FROM legal_file_history h
     LEFT JOIN users u ON u.id = h.performed_by
     WHERE h.file_id = ?
     ORDER BY h.performed_at DESC
     LIMIT 200`
  ).bind(id).all()).results;

  return c.json({ history: rows });
});
