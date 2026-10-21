import { Hono } from 'hono';
import { requireAuth, requireLegalOrHR } from '../lib/auth.js';
import { logActivity, jsonError, nowIso } from '../lib/db.js';

export const legalFileRoutes = new Hono();
legalFileRoutes.use('*', requireAuth, requireLegalOrHR);

// Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ ÙØ¹Ø¯Ø¯ Ø§ÙÙØ³ØªÙØ¯Ø§Øª ÙÙÙ ÙÙÙ
const MAX_DOCS_PER_FILE = 20;
// Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ ÙØ­Ø¬Ù Ø§ÙÙØ³ØªÙØ¯ Ø§ÙÙØ§Ø­Ø¯ (5 MB as base64 â 6.67 MB text)
const MAX_DOC_SIZE_BYTES = 5 * 1024 * 1024;

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
// ÙØ§Ø¦ÙØ© Ø§ÙÙÙÙØ§Øª â ÙØ¹ ÙÙØªØ± Ø­Ø³Ø¨ Ø§ÙÙØ³Ù ÙØ§ÙØ­Ø§ÙØ©
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
// Ø¥Ø­ØµØ§Ø¦ÙØ§Øª Ø³Ø±ÙØ¹Ø© (Ø¹Ø¯Ø¯ Ø§ÙÙÙÙØ§Øª ÙÙ ÙÙ ÙØ³Ù + Ø·ÙØ¨Ø§Øª ÙØ¹ÙÙØ©)
// â ÙØ¬Ø¨ Ø£Ù ØªÙÙÙ ÙØ¨Ù /:id ÙØ£Ù Hono ÙØ·Ø§Ø¨Ù Ø£ÙÙ ÙØ³Ø§Ø± ÙÙØ·Ø¨Ù
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
// ÙØ§Ø¦ÙØ© Ø·ÙØ¨Ø§Øª Ø§ÙÙÙÙ (Ø§ÙÙØ§Ø±Ø¯Ø© ÙÙ)
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
// ÙØ§Ø¦ÙØ© Ø·ÙØ¨Ø§Øª Ø§ÙÙÙÙ Ø§ÙØµØ§Ø¯Ø±Ø© ÙÙÙ
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
// Ø§ÙØ±Ø¯ Ø¹ÙÙ Ø·ÙØ¨ ÙÙÙ (ÙÙØ§ÙÙØ© / Ø±ÙØ¶)
// =====================================================================
legalFileRoutes.patch('/transfers/:transferId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const transferId = Number(c.req.param('transferId'));
  const body = await c.req.json().catch(() => ({}));
  const decision = String(body.decision || '').toUpperCase();

  if (!['APPROVED', 'REJECTED'].includes(decision)) return jsonError(c, 400, 'Ø§ÙÙØ±Ø§Ø± ÙØ¬Ø¨ Ø£Ù ÙÙÙÙ APPROVED Ø£Ù REJECTED', 'INVALID_DECISION');

  const transfer = await db.prepare(`SELECT * FROM legal_file_transfers WHERE id = ? AND status = 'PENDING'`).bind(transferId).first();
  if (!transfer) return jsonError(c, 404, 'Ø§ÙØ·ÙØ¨ ØºÙØ± ÙÙØ¬ÙØ¯ Ø£Ù ØªÙØª ÙØ¹Ø§ÙØ¬ØªÙ', 'NOT_FOUND');

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
// ØªÙØ§ØµÙÙ ÙÙÙ ÙØ§Ø­Ø¯ + ÙØ³ØªÙØ¯Ø§ØªÙ
// =====================================================================
legalFileRoutes.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const file = await db.prepare(`SELECT * FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯', 'NOT_FOUND');

  // Ø§ÙÙØ³ØªÙØ¯Ø§Øª â Ø¨Ø¯ÙÙ data (Ø«ÙÙÙÙ)Ø ØªØªØ­ÙÙÙ ÙØ§Ø­Ø¯Ø© ÙØ§Ø­Ø¯Ø©
  const docs = (await db.prepare(`SELECT id, filename, content_type, file_size, uploaded_by, uploaded_at FROM legal_file_documents WHERE file_id = ? ORDER BY uploaded_at`).bind(id).all()).results;

  return c.json({ file, documents: docs });
});

// =====================================================================
// ØªØ­ÙÙÙ ÙØ³ØªÙØ¯ ÙØ§Ø­Ø¯ (Ø§ÙØ¨ÙØ§ÙØ§Øª Ø§ÙÙØ¹ÙÙØ©)
// =====================================================================
legalFileRoutes.get('/:id/documents/:docId', async (c) => {
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));
  const docId = Number(c.req.param('docId'));
  const doc = await db.prepare(`SELECT * FROM legal_file_documents WHERE id = ? AND file_id = ?`).bind(docId, fileId).first();
  if (!doc) return jsonError(c, 404, 'Ø§ÙÙØ³ØªÙØ¯ ØºÙØ± ÙÙØ¬ÙØ¯', 'DOC_NOT_FOUND');
  return c.json({ document: doc });
});

// =====================================================================
// Ø¥ÙØ´Ø§Ø¡ ÙÙÙ Ø¬Ø¯ÙØ¯
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

  if (!fileNumber) return jsonError(c, 400, 'Ø±ÙÙ Ø§ÙÙÙÙ ÙØ·ÙÙØ¨', 'MISSING_FILE_NUMBER');
  if (!customerName) return jsonError(c, 400, 'Ø§Ø³Ù Ø§ÙØ¹ÙÙÙ ÙØ·ÙÙØ¨', 'MISSING_CUSTOMER_NAME');
  if (!customerPhone) return jsonError(c, 400, 'Ø±ÙÙ ÙØ§ØªÙ Ø§ÙØ¹ÙÙÙ ÙØ·ÙÙØ¨', 'MISSING_CUSTOMER_PHONE');

  // ØªØ­ÙÙ ÙÙ Ø¹Ø¯Ù ØªÙØ±Ø§Ø± Ø±ÙÙ Ø§ÙÙÙÙ
  const existing = await db.prepare(`SELECT id FROM legal_files WHERE file_number = ?`).bind(fileNumber).first();
  if (existing) return jsonError(c, 409, 'Ø±ÙÙ Ø§ÙÙÙÙ ÙÙØ¬ÙØ¯ Ø¨Ø§ÙÙØ¹Ù', 'DUPLICATE_FILE_NUMBER');

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
// ØªØ¹Ø¯ÙÙ Ø¨ÙØ§ÙØ§Øª Ø§ÙÙÙÙ
// =====================================================================
legalFileRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const file = await db.prepare(`SELECT * FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯ Ø£Ù ÙØ¤Ø±Ø´Ù', 'NOT_FOUND');

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

  if (sets.length === 0) return c.json({ ok: true, message: 'ÙØ§ ØªÙØ¬Ø¯ ØªØºÙÙØ±Ø§Øª' });

  // ÙÙ ØºÙÙØ± Ø±ÙÙ Ø§ÙÙÙÙØ ÙØªØ£ÙØ¯ ÙØ´ ÙÙØ±Ø±
  if (changes.file_number) {
    const dup = await db.prepare(`SELECT id FROM legal_files WHERE file_number = ? AND id != ?`).bind(changes.file_number.to, id).first();
    if (dup) return jsonError(c, 409, 'Ø±ÙÙ Ø§ÙÙÙÙ ÙÙØ¬ÙØ¯ Ø¨Ø§ÙÙØ¹Ù', 'DUPLICATE_FILE_NUMBER');
  }

  sets.push('updated_at = ?');
  binds.push(nowIso());
  binds.push(id);

  await db.prepare(`UPDATE legal_files SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await recordHistory(db, { fileId: id, action: 'EDITED', details: changes, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// Ø£Ø±Ø´ÙØ© ÙÙÙ (ÙØ§ Ø­Ø°Ù ÙÙØ§Ø¦Ù)
// =====================================================================
legalFileRoutes.patch('/:id/archive', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯', 'NOT_FOUND');
  if (file.status === 'ARCHIVED') return jsonError(c, 400, 'Ø§ÙÙÙÙ ÙØ¤Ø±Ø´Ù Ø¨Ø§ÙÙØ¹Ù', 'ALREADY_ARCHIVED');

  await db.prepare(`UPDATE legal_files SET status = 'ARCHIVED', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await recordHistory(db, { fileId: id, action: 'ARCHIVED', details: null, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// Ø§Ø³ØªØ¹Ø§Ø¯Ø© ÙÙÙ ÙÙ Ø§ÙØ£Ø±Ø´ÙÙ
// =====================================================================
legalFileRoutes.patch('/:id/restore', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯', 'NOT_FOUND');
  if (file.status !== 'ARCHIVED') return jsonError(c, 400, 'Ø§ÙÙÙÙ ÙÙØ³ ÙØ¤Ø±Ø´ÙÙØ§', 'NOT_ARCHIVED');

  await db.prepare(`UPDATE legal_files SET status = 'ACTIVE', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await recordHistory(db, { fileId: id, action: 'RESTORED', details: null, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// Ø±ÙØ¹ ÙØ³ØªÙØ¯ (ØµÙØ±Ø© / PDF) â base64
// =====================================================================
legalFileRoutes.post('/:id/documents', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯ Ø£Ù ÙØ¤Ø±Ø´Ù', 'NOT_FOUND');

  // Ø§ÙØªØ­ÙÙ ÙÙ Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ
  const countRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM legal_file_documents WHERE file_id = ?`).bind(id).first();
  if (countRow.cnt >= MAX_DOCS_PER_FILE) return jsonError(c, 400, `Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ ${MAX_DOCS_PER_FILE} ÙØ³ØªÙØ¯ ÙÙÙ ÙÙÙ`, 'MAX_DOCS_REACHED');

  const body = await c.req.json().catch(() => ({}));
  const filename = String(body.filename || '').trim();
  const contentType = String(body.contentType || '').trim();
  const data = String(body.data || '');

  if (!filename) return jsonError(c, 400, 'Ø§Ø³Ù Ø§ÙÙÙÙ ÙØ·ÙÙØ¨', 'MISSING_FILENAME');
  if (!contentType) return jsonError(c, 400, 'ÙÙØ¹ Ø§ÙÙÙÙ ÙØ·ÙÙØ¨', 'MISSING_CONTENT_TYPE');
  if (!data) return jsonError(c, 400, 'Ø¨ÙØ§ÙØ§Øª Ø§ÙÙÙÙ ÙØ·ÙÙØ¨Ø©', 'MISSING_DATA');

  // ØªØ­ÙÙ ÙÙ ÙÙØ¹ Ø§ÙÙÙÙ
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  if (!allowedTypes.includes(contentType)) return jsonError(c, 400, 'ÙÙØ¹ Ø§ÙÙÙÙ ØºÙØ± ÙØ¯Ø¹ÙÙ â ØµÙØ± Ø£Ù PDF ÙÙØ·', 'INVALID_CONTENT_TYPE');

  // ØªØ­ÙÙ ÙÙ Ø§ÙØ­Ø¬Ù (base64 â 1.33x)
  const rawSize = Math.ceil((data.length * 3) / 4);
  if (rawSize > MAX_DOC_SIZE_BYTES) return jsonError(c, 400, 'Ø­Ø¬Ù Ø§ÙÙÙÙ Ø£ÙØ¨Ø± ÙÙ 5 ÙÙØ¬Ø§', 'FILE_TOO_LARGE');

  // Ø¹Ø¯Ø¯ Ø§ÙÙØ³ØªÙØ¯Ø§Øª Ø§ÙÙØªØ¨ÙÙØ© Ø¨Ø¹Ø¯ ÙØ°Ø§ Ø§ÙØ±ÙØ¹
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
// Ø­Ø°Ù ÙØ³ØªÙØ¯ (soft â ÙØ§ ÙØ­Ø°Ù ÙØ¹ÙÙÙØ§ ÙÙ DBØ Ø¨Ø³ ÙØ³Ø¬Ù ÙÙ Ø§ÙØªØ§Ø±ÙØ®)
// ÙÙ Ø§ÙÙØ§ÙØ¹ ÙÙØ­Ø°ÙÙ ÙØ£Ù Ø§ÙÙ data ÙØ¨ÙØ±Ø©Ø ÙÙÙ Ø§ÙØªØ§Ø±ÙØ® ÙØ¨ÙÙ
// =====================================================================
legalFileRoutes.delete('/:id/documents/:docId', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const fileId = Number(c.req.param('id'));
  const docId = Number(c.req.param('docId'));

  const doc = await db.prepare(`SELECT id, filename FROM legal_file_documents WHERE id = ? AND file_id = ?`).bind(docId, fileId).first();
  if (!doc) return jsonError(c, 404, 'Ø§ÙÙØ³ØªÙØ¯ ØºÙØ± ÙÙØ¬ÙØ¯', 'DOC_NOT_FOUND');

  await db.prepare(`DELETE FROM legal_file_documents WHERE id = ?`).bind(docId).run();
  await db.prepare(`UPDATE legal_files SET updated_at = ? WHERE id = ?`).bind(nowIso(), fileId).run();
  await recordHistory(db, { fileId, action: 'DOCUMENT_REMOVED', details: { docId, filename: doc.filename }, userId: user.id });

  return c.json({ ok: true });
});

// =====================================================================
// ÙÙÙ ÙÙÙ ÙØ¨Ø§Ø´Ø± (HR â LEGAL) â Ø¨Ø¯ÙÙ Ø·ÙØ¨
// =====================================================================
legalFileRoutes.patch('/:id/move', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const toSection = String(body.toSection || '').toUpperCase();

  if (!['HR', 'LEGAL'].includes(toSection)) return jsonError(c, 400, 'Ø§ÙÙØ³Ù Ø§ÙÙØ·ÙÙØ¨ ØºÙØ± ØµØ­ÙØ­', 'INVALID_SECTION');

  const file = await db.prepare(`SELECT id, current_section, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯ Ø£Ù ÙØ¤Ø±Ø´Ù', 'NOT_FOUND');
  if (file.current_section === toSection) return jsonError(c, 400, 'Ø§ÙÙÙÙ ÙÙØ¬ÙØ¯ Ø¨Ø§ÙÙØ¹Ù ÙÙ ÙØ°Ø§ Ø§ÙÙØ³Ù', 'SAME_SECTION');

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
// Ø¥ÙØ´Ø§Ø¡ Ø·ÙØ¨ ÙÙÙ
// =====================================================================
legalFileRoutes.post('/:id/transfer-request', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || '').trim() || null;

  const file = await db.prepare(`SELECT id, current_section, status FROM legal_files WHERE id = ? AND status = 'ACTIVE'`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯ Ø£Ù ÙØ¤Ø±Ø´Ù', 'NOT_FOUND');

  // Ø§ÙØ·Ø±Ù Ø§ÙÙÙØ§Ø¨Ù
  const mySection = userSection(user);
  const fromSection = file.current_section;
  const toSection = mySection; // Ø£ÙØ§ Ø¹Ø§ÙØ² Ø§ÙÙÙÙ ÙØ¬ÙÙÙ

  if (fromSection === toSection) return jsonError(c, 400, 'Ø§ÙÙÙÙ ÙÙØ¬ÙØ¯ Ø¹ÙØ¯Ù Ø¨Ø§ÙÙØ¹Ù', 'FILE_ALREADY_HERE');

  // ØªØ­ÙÙ ÙÙÙØ´ Ø·ÙØ¨ ÙØ¹ÙÙ Ø¨Ø§ÙÙØ¹Ù
  const pending = await db.prepare(`SELECT id FROM legal_file_transfers WHERE file_id = ? AND status = 'PENDING'`).bind(id).first();
  if (pending) return jsonError(c, 409, 'ÙÙØ¬Ø¯ Ø·ÙØ¨ ÙÙÙ ÙØ¹ÙÙ Ø¨Ø§ÙÙØ¹Ù ÙÙØ°Ø§ Ø§ÙÙÙÙ', 'PENDING_EXISTS');

  const result = await db
    .prepare(`INSERT INTO legal_file_transfers (file_id, from_section, to_section, note, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, fromSection, toSection, note, user.id, nowIso())
    .run();

  await recordHistory(db, { fileId: id, action: 'TRANSFER_REQUESTED', details: { transferId: result.meta.last_row_id, from: fromSection, to: toSection, note }, userId: user.id });

  return c.json({ transferId: result.meta.last_row_id }, 201);
});

// =====================================================================
// ØªØ§Ø±ÙØ® ÙÙÙ ÙØ§Ø­Ø¯
// =====================================================================
legalFileRoutes.get('/:id/history', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));

  const file = await db.prepare(`SELECT id FROM legal_files WHERE id = ?`).bind(id).first();
  if (!file) return jsonError(c, 404, 'Ø§ÙÙÙÙ ØºÙØ± ÙÙØ¬ÙØ¯', 'NOT_FOUND');

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
