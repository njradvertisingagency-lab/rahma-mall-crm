import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { nextCustomerId, logActivity, createNotification, broadcast, jsonError, nowIso } from '../lib/db.js';
import { normalizeEgyptPhone } from '../lib/phone.js';
import { parsePastedNumbers, parseCsvToRecords, parseXlsxToRecords, buildImportPreview } from '../lib/import.js';
import { recordSeenIfNeeded, getCustomerSeenHistory } from '../lib/seen.js';
import { computeCustomerSla, getSlaRules, findSeenSlaCandidates, findContactSlaCandidates, findInterestedFollowupSlaCandidates } from '../lib/sla.js';
import { computeLeadScore } from '../lib/leadscore.js';
import { computeDealStatus, getCustomerLifetimeValue } from '../lib/sales.js';

export const customerRoutes = new Hono();
customerRoutes.use('*', requireAuth);

const STATUSES = ['NEW', 'CALLING', 'NO_ANSWER', 'BUSY', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const CLOSED_REASONS = ['Purchased', 'Not Interested', 'Wrong Number', 'Already Purchased', 'Price', 'Unavailable Product', 'Other'];

function customerRowToJson(row) {
  return {
    id: row.id,
    phone: row.phone,
    normalizedPhone: row.normalized_phone,
    name: row.name,
    status: row.status,
    priority: row.priority,
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.employee_name ?? null,
    source: row.source,
    campaign: row.campaign,
    product: row.product,
    archived: !!row.archived,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    updatedAt: row.updated_at,
    nextFollowUpAt: row.next_follow_up_at,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
    version: row.version,
    whatsappContactStatus: row.whatsapp_contact_status,
    whatsappContactedAt: row.whatsapp_contacted_at,
  };
}

/** Applies server-authoritative scoping: an employee ALWAYS sees only their own customers. */
function scopeToUser(user, sql, binds, conds) {
  if (user.role === 'employee') {
    conds.push('c.assigned_employee_id = ?');
    binds.push(user.employeeId);
  }
}

customerRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['1=1'];
  const binds = [];

  conds.push('c.archived = ?');
  binds.push(q.archived === 'true' ? 1 : 0);

  scopeToUser(user, null, binds, conds);
  if (user.role === 'team_leader' && q.employeeId) {
    if (q.employeeId === 'unassigned') {
      conds.push('c.assigned_employee_id IS NULL');
    } else {
      conds.push('c.assigned_employee_id = ?');
      binds.push(Number(q.employeeId));
    }
  }
  if (q.status) {
    conds.push('c.status = ?');
    binds.push(q.status);
  }
  if (q.priority) {
    conds.push('c.priority = ?');
    binds.push(q.priority);
  }
  if (q.source) {
    conds.push('c.source = ?');
    binds.push(q.source);
  }
  if (q.campaign) {
    conds.push('c.campaign = ?');
    binds.push(q.campaign);
  }
  if (q.dateFrom) {
    conds.push('c.created_at >= ?');
    binds.push(q.dateFrom);
  }
  if (q.dateTo) {
    conds.push('c.created_at <= ?');
    binds.push(q.dateTo);
  }
  if (q.followup === 'overdue') {
    conds.push(`EXISTS (SELECT 1 FROM followups f WHERE f.customer_id = c.id AND (f.status = 'OVERDUE' OR (f.status = 'UPCOMING' AND f.scheduled_for < datetime('now'))))`);
  } else if (q.followup === 'upcoming') {
    conds.push(`c.next_follow_up_at IS NOT NULL AND c.next_follow_up_at >= ?`);
    binds.push(nowIso());
  }
  if (q.whatsappStatus && q.whatsappStatus !== 'ALL') {
    conds.push('c.whatsapp_contact_status = ?');
    binds.push(q.whatsappStatus);
  }
  if (q.seen === 'not_seen') {
    conds.push(`c.assigned_employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`);
  } else if (q.seen === 'seen') {
    conds.push(`c.assigned_employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`);
  }
  if (q.product) {
    conds.push(`EXISTS (SELECT 1 FROM customer_products cp WHERE cp.customer_id = c.id AND cp.product = ?)`);
    binds.push(q.product);
  }
  // Dynamic segments — every condition is derived from real, live data (never a stored tag).
  const SEGMENT_CONDS = {
    NEW: `c.status = 'NEW'`,
    INTERESTED: `c.status = 'INTERESTED'`,
    FOLLOW_UP: `c.status = 'FOLLOW_UP'`,
    NO_ANSWER: `c.status = 'NO_ANSWER'`,
    HIGH_PRIORITY: `c.priority IN ('HIGH','URGENT')`,
    OVERDUE: `EXISTS (SELECT 1 FROM followups f WHERE f.customer_id = c.id AND (f.status = 'OVERDUE' OR (f.status = 'UPCOMING' AND f.scheduled_for < datetime('now'))))`,
    WHATSAPP_CONTACTED: `c.whatsapp_contact_status = 'CONTACT_INITIATED'`,
    NOT_SEEN: `c.assigned_employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`,
    HOT: `c.status = 'INTERESTED' AND c.updated_at >= datetime('now', '-24 hours')`,
  };
  if (q.segment && SEGMENT_CONDS[q.segment]) {
    conds.push(SEGMENT_CONDS[q.segment]);
  } else if (q.segment === 'SLA_BREACHED') {
    // Breach depends on elapsed time against a configurable threshold, so it's resolved to a concrete id list here rather than inlined as static SQL.
    const rules = await getSlaRules(db);
    const [seenC, contactC, interestedC] = await Promise.all([findSeenSlaCandidates(db), findContactSlaCandidates(db), findInterestedFollowupSlaCandidates(db)]);
    const now = Date.now();
    const breachedIds = new Set();
    for (const r of seenC) if ((now - new Date(r.anchor_at).getTime()) / 60000 >= rules.seenWithinMinutes) breachedIds.add(r.customer_id);
    for (const r of contactC) if ((now - new Date(r.anchor_at).getTime()) / 60000 >= rules.contactWithinMinutesAfterSeen) breachedIds.add(r.customer_id);
    for (const r of interestedC) if ((now - new Date(r.anchor_at).getTime()) / 60000 >= rules.followupWithinMinutesAfterInterested) breachedIds.add(r.customer_id);
    const ids = [...breachedIds];
    if (ids.length === 0) {
      conds.push('1=0');
    } else {
      conds.push(`c.id IN (${ids.map(() => '?').join(',')})`);
      binds.push(...ids);
    }
  }
  if (q.q) {
    conds.push(`(c.id LIKE ? OR c.phone LIKE ? OR c.normalized_phone LIKE ? OR c.name LIKE ? OR c.campaign LIKE ? OR c.source LIKE ?)`);
    for (let i = 0; i < 6; i++) binds.push('%' + q.q + '%');
  }

  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const where = conds.join(' AND ');
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${where}`)
    .bind(...binds)
    .first();

  const sortMap = {
    createdAt: 'c.created_at',
    updatedAt: 'c.updated_at',
    nextFollowUpAt: 'c.next_follow_up_at',
    priority: 'c.priority',
    status: 'c.status',
  };
  const sortCol = sortMap[q.sort] || 'c.created_at';
  const sortDir = q.dir === 'asc' ? 'ASC' : 'DESC';

  const rows = await db
    .prepare(
      `SELECT c.*, e.name AS employee_name FROM customers c
       LEFT JOIN employees e ON e.id = c.assigned_employee_id
       WHERE ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
    )
    .bind(...binds, pageSize, offset)
    .all();

  return c.json({
    customers: rows.results.map(customerRowToJson),
    pagination: { page, pageSize, total: countRow.n },
  });
});

customerRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const row = await db
    .prepare(
      `SELECT c.*, e.name AS employee_name, wu.display_name AS whatsapp_contacted_by_name
       FROM customers c
       LEFT JOIN employees e ON e.id = c.assigned_employee_id
       LEFT JOIN users wu ON wu.id = c.whatsapp_contacted_by
       WHERE c.id = ?`
    )
    .bind(id)
    .first();
  if (!row) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && row.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  // Seen is recorded ONLY here — an actual, explicit open of the customer's
  // detail page by the employee it is currently assigned to. A list load
  // never counts. Team Leader views never mark it seen (they have no
  // employee_id / seen is an employee-engagement signal, not a TL one).
  if (user.role === 'employee' && row.assigned_employee_id === user.employeeId) {
    await recordSeenIfNeeded(db, c.env, { customerId: id, employeeId: user.employeeId });
  }

  const [notes, followups, statusHistory, assignments, callAttempts, branchVisits, purchases, products, seenHistory, sla, leadScore] = await Promise.all([
    db.prepare(`SELECT * FROM customer_notes WHERE customer_id = ? ORDER BY created_at ASC`).bind(id).all(),
    db.prepare(`SELECT f.*, e.name AS employee_name FROM followups f LEFT JOIN employees e ON e.id = f.employee_id WHERE f.customer_id = ? ORDER BY f.scheduled_for ASC`).bind(id).all(),
    db.prepare(`SELECT * FROM customer_status_history WHERE customer_id = ? ORDER BY changed_at ASC`).bind(id).all(),
    db.prepare(`SELECT a.*, e.name AS employee_name FROM customer_assignments a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.customer_id = ? ORDER BY a.assigned_at ASC`).bind(id).all(),
    db.prepare(`SELECT ca.*, u.display_name AS attempted_by_name FROM call_attempts ca LEFT JOIN users u ON u.id = ca.attempted_by WHERE ca.customer_id = ? ORDER BY ca.created_at DESC`).bind(id).all(),
    db.prepare(`SELECT bv.*, br.name AS branch_name, e.name AS employee_name FROM customer_branch_visits bv JOIN branches br ON br.id = bv.branch_id LEFT JOIN employees e ON e.id = bv.employee_id WHERE bv.customer_id = ? ORDER BY bv.visit_at DESC`).bind(id).all(),
    db.prepare(`SELECT p.*, br.name AS branch_name, e.name AS employee_name FROM purchase_transactions p JOIN branches br ON br.id = p.branch_id LEFT JOIN employees e ON e.id = p.attributed_employee_id WHERE p.customer_id = ? ORDER BY p.purchase_at DESC`).bind(id).all(),
    db.prepare(`SELECT product FROM customer_products WHERE customer_id = ? ORDER BY created_at ASC`).bind(id).all(),
    getCustomerSeenHistory(db, id),
    computeCustomerSla(db, id),
    computeLeadScore(db, id),
  ]);

  const purchaseIds = purchases.results.map((p) => p.id);
  let itemsByPurchase = {};
  if (purchaseIds.length) {
    const items = await db.prepare(`SELECT * FROM purchase_items WHERE purchase_id IN (${purchaseIds.map(() => '?').join(',')})`).bind(...purchaseIds).all();
    itemsByPurchase = items.results.reduce((acc, it) => { (acc[it.purchase_id] = acc[it.purchase_id] || []).push(it); return acc; }, {});
  }

  const activity = await db
    .prepare(`SELECT * FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ? ORDER BY created_at ASC`)
    .bind(id)
    .all();

  const [dealStatus, lifetimeValue] = await Promise.all([computeDealStatus(db, id), getCustomerLifetimeValue(db, id)]);

  return c.json({
    customer: { ...customerRowToJson(row), whatsappContactedByName: row.whatsapp_contacted_by_name || null, dealStatus, leadScore: leadScore.score, leadScoreReasons: leadScore.reasons, sla },
    notes: notes.results,
    followups: followups.results,
    statusHistory: statusHistory.results,
    assignmentHistory: assignments.results,
    callAttempts: callAttempts.results,
    branchVisits: branchVisits.results,
    purchases: purchases.results.map((p) => ({ ...p, items: itemsByPurchase[p.id] || [] })),
    lifetimeValue,
    products: products.results.map((r) => r.product),
    seenHistory,
    timeline: activity.results,
  });
});

customerRoutes.post('/', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const { valid, normalized, reason } = normalizeEgyptPhone(body.phone);
  if (!valid) return jsonError(c, 400, `Invalid Egyptian phone number (${reason})`, 'INVALID_PHONE');

  const dup = await db.prepare(`SELECT id FROM customers WHERE normalized_phone = ? AND archived = 0`).bind(normalized).first();
  if (dup) return jsonError(c, 409, 'A customer with this phone number already exists: ' + dup.id, 'DUPLICATE_PHONE');

  const id = await nextCustomerId(db);
  await db
    .prepare(
      `INSERT INTO customers (id, phone, normalized_phone, name, source, campaign, product, priority, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, body.phone, normalized, body.name || null, body.source || null, body.campaign || null, body.product || null, PRIORITIES.includes(body.priority) ? body.priority : 'NORMAL', user.id)
    .run();
  await db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason) VALUES (?, NULL, ?, 'IMPORT_UNASSIGNED')`).bind(id, user.id).run();
  await db.prepare(`INSERT INTO customer_status_history (customer_id, from_status, to_status, changed_by) VALUES (?, NULL, 'NEW', ?)`).bind(id, user.id).run();
  await logActivity(db, { actor: user, action: 'CUSTOMER_CREATED', entityType: 'customer', entityId: id, metadata: { phone: normalized } });
  await broadcast(c.env, 'CUSTOMER_CREATED', { id }, { scope: 'role', role: 'team_leader' });

  return c.json({ customer: { id, normalizedPhone: normalized } }, 201);
});

// ---------------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------------
customerRoutes.post('/import/preview', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const contentType = c.req.header('content-type') || '';
  let records;
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file) return jsonError(c, 400, 'No file uploaded', 'NO_FILE');
    const name = file.name || '';
    const buf = await file.arrayBuffer();
    if (name.toLowerCase().endsWith('.csv')) {
      const text = new TextDecoder('utf-8').decode(buf);
      records = parseCsvToRecords(text).records;
    } else {
      records = parseXlsxToRecords(buf).records;
    }
  } else {
    const body = await c.req.json().catch(() => ({}));
    if (body.text) {
      records = parsePastedNumbers(body.text);
    } else if (body.csv) {
      records = parseCsvToRecords(body.csv).records;
    } else {
      return jsonError(c, 400, 'Provide `text` (pasted numbers) or `csv` (CSV content)', 'NO_INPUT');
    }
  }

  const existingRows = await db.prepare(`SELECT normalized_phone FROM customers WHERE archived = 0`).all();
  const existingSet = new Set(existingRows.results.map((r) => r.normalized_phone));
  const preview = buildImportPreview(records, existingSet);

  // Stash the parsed rows keyed by a short-lived token so /commit doesn't have
  // to re-parse (and definitely doesn't trust a client-resubmitted row list).
  const token = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind('import_preview_' + token, JSON.stringify({ rows: preview.rows, createdAt: nowIso() }))
    .run();

  return c.json({ token, summary: preview.summary, rows: preview.rows.slice(0, 500) });
});

customerRoutes.post('/import/commit', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const stash = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind('import_preview_' + body.token).first();
  if (!stash) return jsonError(c, 400, 'Import preview expired or not found — please re-run the preview', 'PREVIEW_EXPIRED');
  const { rows } = JSON.parse(stash.value);
  const newRows = rows.filter((r) => r.status === 'NEW');
  if (newRows.length === 0) return jsonError(c, 400, 'Nothing new to import', 'NOTHING_TO_IMPORT');

  const createdIds = [];
  for (const r of newRows) {
    const id = await nextCustomerId(db);
    await db
      .prepare(
        `INSERT INTO customers (id, phone, normalized_phone, name, source, campaign, product, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, r.rawPhone, r.normalizedPhone, r.name || null, r.source || null, r.campaign || null, r.product || null, user.id)
      .run();
    await db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason) VALUES (?, NULL, ?, 'IMPORT_UNASSIGNED')`).bind(id, user.id).run();
    await db.prepare(`INSERT INTO customer_status_history (customer_id, from_status, to_status, changed_by) VALUES (?, NULL, 'NEW', ?)`).bind(id, user.id).run();
    createdIds.push(id);
  }
  await db.prepare(`DELETE FROM settings WHERE key = ?`).bind('import_preview_' + body.token).run();
  await logActivity(db, { actor: user, action: 'CUSTOMERS_IMPORTED', entityType: 'import', entityId: null, metadata: { count: createdIds.length } });
  await broadcast(c.env, 'CUSTOMERS_IMPORTED', { count: createdIds.length }, { scope: 'role', role: 'team_leader' });

  return c.json({ imported: createdIds.length, customerIds: createdIds });
});

// ---------------------------------------------------------------------------
// FIELD EDIT (optimistic concurrency via version)
// ---------------------------------------------------------------------------
customerRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }
  if (body.version && body.version !== existing.version) {
    return jsonError(c, 409, 'This customer was modified by someone else — refresh and retry', 'VERSION_CONFLICT');
  }
  const fields = [];
  const binds = [];
  for (const [key, col] of [
    ['name', 'name'],
    ['source', 'source'],
    ['campaign', 'campaign'],
    ['product', 'product'],
  ]) {
    if (key in body) {
      fields.push(`${col} = ?`);
      binds.push(body[key]);
    }
  }
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) return jsonError(c, 400, 'Invalid priority', 'INVALID_PRIORITY');
    fields.push('priority = ?');
    binds.push(body.priority);
  }
  if (fields.length === 0) return jsonError(c, 400, 'No fields to update', 'NO_FIELDS');
  fields.push('updated_at = ?', 'version = version + 1');
  binds.push(nowIso());
  binds.push(id);
  await db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).bind(...binds).run();

  if ('priority' in body && body.priority !== existing.priority) {
    await logActivity(db, { actor: user, action: 'PRIORITY_CHANGED', entityType: 'customer', entityId: id, metadata: { from: existing.priority, to: body.priority } });
    await broadcast(c.env, 'CUSTOMER_PRIORITY_CHANGED', { id, priority: body.priority }, { scope: 'role', role: 'team_leader' });
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// STATUS CHANGE
// ---------------------------------------------------------------------------
customerRoutes.patch('/:id/status', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const toStatus = body.status;
  if (!STATUSES.includes(toStatus)) return jsonError(c, 400, 'Invalid status', 'INVALID_STATUS');

  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  let closedReason = null;
  let closedAt = null;
  let closedBy = null;
  if (toStatus === 'CLOSED') {
    if (!body.closedReason || !CLOSED_REASONS.includes(body.closedReason)) {
      return jsonError(c, 400, 'A valid closed reason is required to close a customer', 'CLOSED_REASON_REQUIRED');
    }
    if (body.closedReason === 'Other' && !body.closedReasonText) {
      return jsonError(c, 400, 'Custom text is required when reason is "Other"', 'CLOSED_REASON_TEXT_REQUIRED');
    }
    closedReason = body.closedReason === 'Other' ? `Other: ${body.closedReasonText}` : body.closedReason;
    closedAt = nowIso();
    closedBy = user.id;
  }

  await db
    .prepare(
      `UPDATE customers SET status = ?, closed_at = ?, closed_reason = ?, closed_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`
    )
    .bind(toStatus, closedAt, closedReason, closedBy, nowIso(), id)
    .run();
  await db
    .prepare(`INSERT INTO customer_status_history (customer_id, from_status, to_status, changed_by, note) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, existing.status, toStatus, user.id, closedReason)
    .run();
  await logActivity(db, {
    actor: user,
    action: 'STATUS_CHANGED',
    entityType: 'customer',
    entityId: id,
    metadata: { from: existing.status, to: toStatus, closedReason },
  });

  await broadcast(c.env, 'CUSTOMER_STATUS_CHANGED', { id, from: existing.status, to: toStatus, employeeId: existing.assigned_employee_id }, { scope: 'role', role: 'team_leader' });
  if (existing.assigned_employee_id) {
    const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(existing.assigned_employee_id).first();
    if (emp) await broadcast(c.env, 'CUSTOMER_STATUS_CHANGED', { id, from: existing.status, to: toStatus }, { scope: 'user', userId: emp.user_id });
  }
  if (toStatus === 'CLOSED') {
    await broadcast(c.env, 'CUSTOMER_CLOSED', { id, closedReason }, { scope: 'role', role: 'team_leader' });
  }

  return c.json({ ok: true, status: toStatus });
});

customerRoutes.post('/:id/reopen', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (existing.status !== 'CLOSED') return jsonError(c, 400, 'Only closed customers can be reopened', 'NOT_CLOSED');

  await db
    .prepare(`UPDATE customers SET status = 'FOLLOW_UP', closed_at = NULL, closed_reason = NULL, closed_by = NULL, updated_at = ?, version = version + 1 WHERE id = ?`)
    .bind(nowIso(), id)
    .run();
  await db.prepare(`INSERT INTO customer_status_history (customer_id, from_status, to_status, changed_by, note) VALUES (?, 'CLOSED', 'FOLLOW_UP', ?, 'Reopened')`).bind(id, user.id).run();
  await logActivity(db, { actor: user, action: 'CUSTOMER_REOPENED', entityType: 'customer', entityId: id });
  await broadcast(c.env, 'CUSTOMER_REOPENED', { id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// NOTES
// ---------------------------------------------------------------------------
customerRoutes.post('/:id/notes', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (!body.note || !String(body.note).trim()) return jsonError(c, 400, 'Note text is required', 'EMPTY_NOTE');

  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  const res = await db
    .prepare(`INSERT INTO customer_notes (customer_id, author_id, author_name, note) VALUES (?, ?, ?, ?) RETURNING id, created_at`)
    .bind(id, user.id, user.displayName, String(body.note).trim())
    .first();
  await db.prepare(`UPDATE customers SET updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'NOTE_ADDED', entityType: 'customer', entityId: id, metadata: { noteId: res.id } });
  await broadcast(c.env, 'CUSTOMER_NOTE_ADDED', { id, note: body.note, author: user.displayName }, { scope: 'role', role: 'team_leader' });

  return c.json({ note: { id: res.id, note: body.note, authorName: user.displayName, createdAt: res.created_at } }, 201);
});

// ---------------------------------------------------------------------------
// PRODUCT INTEREST (a customer may be interested in more than one product)
// ---------------------------------------------------------------------------
customerRoutes.post('/:id/products', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const product = String(body.product || '').trim();
  if (!product) return jsonError(c, 400, 'Product name is required', 'MISSING_PRODUCT');

  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  await db.prepare(`INSERT OR IGNORE INTO customer_products (customer_id, product) VALUES (?, ?)`).bind(id, product).run();
  await db.prepare(`INSERT OR IGNORE INTO products (name) VALUES (?)`).bind(product).run();
  await logActivity(db, { actor: user, action: 'PRODUCT_INTEREST_ADDED', entityType: 'customer', entityId: id, metadata: { product } });
  const products = await db.prepare(`SELECT product FROM customer_products WHERE customer_id = ? ORDER BY created_at ASC`).bind(id).all();
  return c.json({ products: products.results.map((r) => r.product) }, 201);
});

customerRoutes.delete('/:id/products/:product', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const product = decodeURIComponent(c.req.param('product'));
  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }
  await db.prepare(`DELETE FROM customer_products WHERE customer_id = ? AND product = ?`).bind(id, product).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CALL INITIATION (logging only — never claims a call actually completed)
// ---------------------------------------------------------------------------
customerRoutes.post('/:id/call', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }
  await logActivity(db, { actor: user, action: 'CALL_INITIATED', entityType: 'customer', entityId: id, metadata: { phone: existing.normalized_phone } });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CALL ATTEMPT OUTCOME — explicit, employee-recorded, never inferred. There is
// no telephony integration, so the system has no way to know whether a call
// was answered; the employee tells it after the fact.
// ---------------------------------------------------------------------------
const CALL_OUTCOMES = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SWITCHED_OFF', 'REJECTED'];
customerRoutes.post('/:id/call-attempts', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (!CALL_OUTCOMES.includes(body.outcome)) return jsonError(c, 400, 'A valid call outcome is required', 'INVALID_OUTCOME');

  const existing = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (user.role === 'employee' && existing.assigned_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your customer', 'FORBIDDEN_OWNERSHIP');
  }

  const res = await db
    .prepare(`INSERT INTO call_attempts (customer_id, employee_id, attempted_by, outcome, notes) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`)
    .bind(id, existing.assigned_employee_id, user.id, body.outcome, body.notes || null)
    .first();
  await db.prepare(`UPDATE customers SET updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'CALL_ATTEMPT_CREATED', entityType: 'customer', entityId: id, metadata: { outcome: body.outcome } });
  await broadcast(c.env, 'CALL_ATTEMPT_CREATED', { id, outcome: body.outcome, employeeId: existing.assigned_employee_id }, { scope: 'role', role: 'team_leader' });

  const leadScore = await computeLeadScore(db, id);
  await broadcast(c.env, 'LEAD_SCORE_UPDATED', { id, score: leadScore.score }, { scope: 'role', role: 'team_leader' });

  return c.json({ callAttempt: { id: res.id, outcome: body.outcome, notes: body.notes || null, createdAt: res.created_at }, leadScore: leadScore.score }, 201);
});

// ---------------------------------------------------------------------------
// ARCHIVE / RESTORE
// ---------------------------------------------------------------------------
customerRoutes.post('/:id/archive', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  await db.prepare(`UPDATE customers SET archived = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: c.get('user'), action: 'CUSTOMER_ARCHIVED', entityType: 'customer', entityId: id });
  await broadcast(c.env, 'CUSTOMER_ARCHIVED', { id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

customerRoutes.post('/:id/restore', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  await db.prepare(`UPDATE customers SET archived = 0, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: c.get('user'), action: 'CUSTOMER_RESTORED', entityType: 'customer', entityId: id });
  await broadcast(c.env, 'CUSTOMER_RESTORED', { id }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// BULK ACTIONS (Team Leader only)
// ---------------------------------------------------------------------------
customerRoutes.post('/bulk', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.customerIds) ? body.customerIds : [];
  if (ids.length === 0) return jsonError(c, 400, 'No customers selected', 'NO_SELECTION');
  const action = body.action;

  let affected = 0;
  if (action === 'STATUS') {
    if (!STATUSES.includes(body.status)) return jsonError(c, 400, 'Invalid status', 'INVALID_STATUS');
    for (const id of ids) {
      const existing = await db.prepare(`SELECT status FROM customers WHERE id = ?`).bind(id).first();
      if (!existing) continue;
      await db.prepare(`UPDATE customers SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(body.status, nowIso(), id).run();
      await db.prepare(`INSERT INTO customer_status_history (customer_id, from_status, to_status, changed_by, note) VALUES (?, ?, ?, ?, 'Bulk update')`).bind(id, existing.status, body.status, user.id).run();
      affected++;
    }
  } else if (action === 'PRIORITY') {
    if (!PRIORITIES.includes(body.priority)) return jsonError(c, 400, 'Invalid priority', 'INVALID_PRIORITY');
    for (const id of ids) {
      await db.prepare(`UPDATE customers SET priority = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(body.priority, nowIso(), id).run();
      affected++;
    }
  } else if (action === 'ARCHIVE') {
    for (const id of ids) {
      await db.prepare(`UPDATE customers SET archived = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
      affected++;
    }
  } else {
    return jsonError(c, 400, 'Unsupported bulk action (use the /distributions or /reassignments endpoints for assignment changes)', 'UNSUPPORTED_ACTION');
  }

  await logActivity(db, { actor: user, action: 'BULK_' + action, entityType: 'customer', entityId: null, metadata: { count: affected, ids } });
  await broadcast(c.env, 'CUSTOMERS_BULK_UPDATED', { action, count: affected }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true, affected });
});
