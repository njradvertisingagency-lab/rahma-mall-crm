// SalesService — branch visits, purchases ("Deal Done"), refunds and
// attribution. Kept as a single service layer (per section 61 of the spec) so
// a future POS/e-commerce integration only has to implement syncFromPOS()
// without touching call sites elsewhere in the app.
//
// Deal Status (NO_PURCHASE/BRANCH_VISIT/COMPLETED/CANCELLED/REFUNDED/
// PARTIALLY_REFUNDED) is ALWAYS computed live here from purchase_transactions
// + customer_branch_visits — it is never a stored column, so it can never
// drift from the underlying transactions. It is completely separate from
// customers.status (the call-team pipeline status) — nothing here ever
// touches that column.
import { nowIso, broadcast, createNotification, logActivity } from './db.js';

export async function getSalesSettings(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'sales_settings'`).first();
  const defaults = { taxRatePercent: 0, paymentMethods: ['CASH', 'CARD', 'INSTALLMENT', 'OTHER'] };
  if (!row) return defaults;
  try {
    return { ...defaults, ...JSON.parse(row.value) };
  } catch {
    return defaults;
  }
}

export function computeTotals(items, taxRatePercent) {
  const subtotal = items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.unitPrice || 0), 0);
  const discountTotal = items.reduce((s, it) => s + Number(it.discount || 0), 0);
  const afterDiscount = Math.max(0, subtotal - discountTotal);
  const taxTotal = Math.round(afterDiscount * (Number(taxRatePercent || 0) / 100) * 100) / 100;
  const totalAmount = Math.round((afterDiscount + taxTotal) * 100) / 100;
  return { subtotal: round2(subtotal), discountTotal: round2(discountTotal), taxTotal, totalAmount };
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

export async function createBranchVisit(db, env, { customerId, employeeId, branchId, notes, createdBy }) {
  const branch = await db.prepare(`SELECT id, name FROM branches WHERE id = ? AND active = 1`).bind(branchId).first();
  if (!branch) throw httpError(400, 'Invalid branch', 'INVALID_BRANCH');
  const res = await db
    .prepare(`INSERT INTO customer_branch_visits (customer_id, employee_id, branch_id, notes, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id, visit_at`)
    .bind(customerId, employeeId ?? null, branchId, notes || null, createdBy)
    .first();
  await logActivity(db, { actor: { id: createdBy }, action: 'BRANCH_VISIT_CREATED', entityType: 'customer', entityId: customerId, metadata: { branchId, branchName: branch.name } });
  await broadcast(env, 'BRANCH_VISIT_CREATED', { customerId, branchId, branchName: branch.name, employeeId }, { scope: 'role', role: 'team_leader' });
  if (employeeId) await broadcast(env, 'BRANCH_VISIT_CREATED', { customerId, branchId, branchName: branch.name }, { scope: 'employee', employeeId });
  return { id: res.id, visitAt: res.visit_at, branchName: branch.name };
}

export async function createManualPurchase(db, env, input) {
  const { customerId, branchId, purchaseAt, invoiceNumber, orderId, items, paymentMethod, notes, attributedEmployeeId, createdBy } = input;

  const branch = await db.prepare(`SELECT id, name FROM branches WHERE id = ? AND active = 1`).bind(branchId).first();
  if (!branch) throw httpError(400, 'Invalid branch', 'INVALID_BRANCH');
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'At least one product line is required', 'NO_ITEMS');

  if (invoiceNumber) {
    const dupe = await db.prepare(`SELECT id FROM purchase_transactions WHERE invoice_number = ?`).bind(invoiceNumber).first();
    if (dupe) throw httpError(409, 'This transaction already exists (duplicate invoice number).', 'DUPLICATE_INVOICE');
  }
  if (orderId) {
    const dupe = await db.prepare(`SELECT id FROM purchase_transactions WHERE order_id = ?`).bind(orderId).first();
    if (dupe) throw httpError(409, 'This transaction already exists (duplicate order ID).', 'DUPLICATE_ORDER_ID');
  }

  const settings = await getSalesSettings(db);
  const { subtotal, discountTotal, taxTotal, totalAmount } = computeTotals(items, settings.taxRatePercent);

  const purchase = await db
    .prepare(
      `INSERT INTO purchase_transactions
        (customer_id, attributed_employee_id, branch_id, purchase_at, invoice_number, order_id, subtotal, discount_total, tax_total, total_amount, payment_method, status, notes, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, 'MANUAL', ?)
       RETURNING id, purchase_at`
    )
    .bind(
      customerId,
      attributedEmployeeId ?? null,
      branchId,
      purchaseAt || nowIso(),
      invoiceNumber || null,
      orderId || null,
      subtotal,
      discountTotal,
      taxTotal,
      totalAmount,
      paymentMethod || 'CASH',
      notes || null,
      createdBy
    )
    .first();

  const stmts = items.map((it) =>
    db
      .prepare(`INSERT INTO purchase_items (purchase_id, product_id, product_name, sku, quantity, unit_price, discount, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        purchase.id,
        it.productId ?? null,
        it.productName,
        it.sku || null,
        Number(it.quantity || 1),
        Number(it.unitPrice || 0),
        Number(it.discount || 0),
        round2(Number(it.quantity || 1) * Number(it.unitPrice || 0) - Number(it.discount || 0))
      )
  );
  await db.batch(stmts);

  await logActivity(db, {
    actor: { id: createdBy },
    action: 'DEAL_DONE_CREATED',
    entityType: 'customer',
    entityId: customerId,
    metadata: { purchaseId: purchase.id, amount: totalAmount, branchName: branch.name, invoiceNumber: invoiceNumber || null },
  });

  const tls = await db.prepare(`SELECT id FROM users WHERE role = 'team_leader' AND active = 1`).all();
  for (const tl of tls.results) {
    await createNotification(db, {
      userId: tl.id,
      type: 'DEAL_DONE',
      title: '🎉 Deal Done',
      message: `A new purchase of ${totalAmount} was recorded at ${branch.name}.`,
      entityType: 'customer',
      entityId: customerId,
    });
  }
  await broadcast(env, 'DEAL_DONE_CREATED', { customerId, purchaseId: purchase.id, amount: totalAmount, branchId, branchName: branch.name }, { scope: 'role', role: 'team_leader' });
  await broadcast(env, 'PURCHASE_CREATED', { customerId, purchaseId: purchase.id, amount: totalAmount }, { scope: 'role', role: 'team_leader' });
  if (attributedEmployeeId) await broadcast(env, 'DEAL_DONE_CREATED', { customerId, purchaseId: purchase.id, amount: totalAmount }, { scope: 'employee', employeeId: attributedEmployeeId });
  await broadcast(env, 'REVENUE_UPDATED', {}, { scope: 'role', role: 'team_leader' });

  return { id: purchase.id, purchaseAt: purchase.purchase_at, totalAmount, subtotal, discountTotal, taxTotal };
}

export async function getPurchase(db, purchaseId) {
  const purchase = await db
    .prepare(`SELECT p.*, br.name AS branch_name, e.name AS employee_name FROM purchase_transactions p JOIN branches br ON br.id = p.branch_id LEFT JOIN employees e ON e.id = p.attributed_employee_id WHERE p.id = ?`)
    .bind(purchaseId)
    .first();
  if (!purchase) return null;
  const items = await db.prepare(`SELECT * FROM purchase_items WHERE purchase_id = ?`).bind(purchaseId).all();
  const refunds = await db.prepare(`SELECT * FROM purchase_refunds WHERE purchase_id = ? ORDER BY created_at ASC`).bind(purchaseId).all();
  return { ...purchase, items: items.results, refunds: refunds.results };
}

/** Audited field edit — never a silent overwrite (section 42). */
export async function updatePurchase(db, env, purchaseId, changes, { changedBy, reason }) {
  const existing = await db.prepare(`SELECT * FROM purchase_transactions WHERE id = ?`).bind(purchaseId).first();
  if (!existing) throw httpError(404, 'Purchase not found', 'NOT_FOUND');

  const fields = [];
  const binds = [];
  const auditRows = [];
  for (const [key, col] of [
    ['branchId', 'branch_id'],
    ['paymentMethod', 'payment_method'],
    ['notes', 'notes'],
    ['invoiceNumber', 'invoice_number'],
    ['orderId', 'order_id'],
  ]) {
    if (key in changes && changes[key] !== existing[col]) {
      fields.push(`${col} = ?`);
      binds.push(changes[key]);
      auditRows.push({ field: col, oldValue: String(existing[col] ?? ''), newValue: String(changes[key] ?? '') });
    }
  }
  if (fields.length === 0) return existing;
  fields.push('updated_at = ?');
  binds.push(nowIso(), purchaseId);
  await db.prepare(`UPDATE purchase_transactions SET ${fields.join(', ')} WHERE id = ?`).bind(...binds).run();

  for (const row of auditRows) {
    await db
      .prepare(`INSERT INTO purchase_audit_log (purchase_id, field, old_value, new_value, changed_by, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(purchaseId, row.field, row.oldValue, row.newValue, changedBy, reason || null)
      .run();
  }
  await logActivity(db, { actor: { id: changedBy }, action: 'PURCHASE_UPDATED', entityType: 'customer', entityId: existing.customer_id, metadata: { purchaseId, fields: auditRows } });
  await broadcast(env, 'PURCHASE_UPDATED', { customerId: existing.customer_id, purchaseId }, { scope: 'role', role: 'team_leader' });
  return await getPurchase(db, purchaseId);
}

export async function cancelPurchase(db, env, purchaseId, { cancelledBy, reason }) {
  const existing = await db.prepare(`SELECT * FROM purchase_transactions WHERE id = ?`).bind(purchaseId).first();
  if (!existing) throw httpError(404, 'Purchase not found', 'NOT_FOUND');
  if (existing.status === 'CANCELLED') throw httpError(400, 'Already cancelled', 'ALREADY_CANCELLED');

  await db
    .prepare(`UPDATE purchase_transactions SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), cancelledBy, reason || null, nowIso(), purchaseId)
    .run();
  await db
    .prepare(`INSERT INTO purchase_audit_log (purchase_id, field, old_value, new_value, changed_by, reason) VALUES (?, 'status', ?, 'CANCELLED', ?, ?)`)
    .bind(purchaseId, existing.status, cancelledBy, reason || null)
    .run();
  await logActivity(db, { actor: { id: cancelledBy }, action: 'PURCHASE_CANCELLED', entityType: 'customer', entityId: existing.customer_id, metadata: { purchaseId, reason } });
  await broadcast(env, 'PURCHASE_CANCELLED', { customerId: existing.customer_id, purchaseId }, { scope: 'role', role: 'team_leader' });
  await broadcast(env, 'REVENUE_UPDATED', {}, { scope: 'role', role: 'team_leader' });
  return await getPurchase(db, purchaseId);
}

/** Full or partial refund. Status is recomputed automatically from the refunded total vs the purchase amount. */
export async function createRefund(db, env, purchaseId, { refundAmount, refundReason, refundNotes, refundedBy }) {
  const existing = await db.prepare(`SELECT * FROM purchase_transactions WHERE id = ?`).bind(purchaseId).first();
  if (!existing) throw httpError(404, 'Purchase not found', 'NOT_FOUND');
  if (existing.status === 'CANCELLED') throw httpError(400, 'Cannot refund a cancelled purchase', 'PURCHASE_CANCELLED');
  const amount = Number(refundAmount);
  if (!(amount > 0)) throw httpError(400, 'Refund amount must be greater than zero', 'INVALID_AMOUNT');
  const alreadyRefunded = existing.refunded_amount || 0;
  if (alreadyRefunded + amount > existing.total_amount + 0.01) {
    throw httpError(400, 'Refund amount exceeds the remaining refundable balance', 'REFUND_EXCEEDS_TOTAL');
  }

  await db
    .prepare(`INSERT INTO purchase_refunds (purchase_id, refund_amount, refund_reason, refund_notes, refunded_by) VALUES (?, ?, ?, ?, ?)`)
    .bind(purchaseId, amount, refundReason || null, refundNotes || null, refundedBy)
    .run();

  const newRefundedTotal = round2(alreadyRefunded + amount);
  const newStatus = newRefundedTotal >= existing.total_amount - 0.01 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await db.prepare(`UPDATE purchase_transactions SET refunded_amount = ?, status = ?, updated_at = ? WHERE id = ?`).bind(newRefundedTotal, newStatus, nowIso(), purchaseId).run();

  await logActivity(db, { actor: { id: refundedBy }, action: 'REFUND_CREATED', entityType: 'customer', entityId: existing.customer_id, metadata: { purchaseId, amount, reason: refundReason } });
  const event = newStatus === 'REFUNDED' ? 'PURCHASE_REFUNDED' : 'PURCHASE_PARTIALLY_REFUNDED';
  await broadcast(env, event, { customerId: existing.customer_id, purchaseId, amount }, { scope: 'role', role: 'team_leader' });
  await broadcast(env, 'REVENUE_UPDATED', {}, { scope: 'role', role: 'team_leader' });
  return await getPurchase(db, purchaseId);
}

export async function getCustomerPurchases(db, customerId) {
  const rows = await db
    .prepare(`SELECT p.*, br.name AS branch_name, e.name AS employee_name FROM purchase_transactions p JOIN branches br ON br.id = p.branch_id LEFT JOIN employees e ON e.id = p.attributed_employee_id WHERE p.customer_id = ? ORDER BY p.purchase_at DESC`)
    .bind(customerId)
    .all();
  return rows.results;
}

/** Customer Lifetime Value summary (section 20). */
export async function getCustomerLifetimeValue(db, customerId) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN status != 'CANCELLED' THEN total_amount ELSE 0 END), 0) AS grossRevenue,
              COALESCE(SUM(CASE WHEN status != 'CANCELLED' THEN refunded_amount ELSE 0 END), 0) AS refunds
       FROM purchase_transactions WHERE customer_id = ?`
    )
    .bind(customerId)
    .first();
  const netRevenue = round2(row.grossRevenue - row.refunds);
  return {
    orders: row.orders,
    grossRevenue: round2(row.grossRevenue),
    refunds: round2(row.refunds),
    netRevenue,
    averageOrderValue: row.orders > 0 ? round2(netRevenue / row.orders) : 0,
  };
}

/** Never a stored column — always derived from real transactions/visits (section 40). */
export async function computeDealStatus(db, customerId) {
  const purchase = await db
    .prepare(`SELECT status FROM purchase_transactions WHERE customer_id = ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED') ORDER BY purchase_at DESC LIMIT 1`)
    .bind(customerId)
    .first();
  if (purchase) return purchase.status;
  const visit = await db.prepare(`SELECT id FROM customer_branch_visits WHERE customer_id = ? LIMIT 1`).bind(customerId).first();
  return visit ? 'BRANCH_VISIT' : 'NO_PURCHASE';
}

/** Explicit only — never silently overwritten (sections 26/27/64). */
export async function changeAttribution(db, env, purchaseId, { newEmployeeId, changedBy, reason }) {
  const existing = await db.prepare(`SELECT * FROM purchase_transactions WHERE id = ?`).bind(purchaseId).first();
  if (!existing) throw httpError(404, 'Purchase not found', 'NOT_FOUND');
  if (existing.attributed_employee_id === newEmployeeId) return existing;

  await db.prepare(`UPDATE purchase_transactions SET attributed_employee_id = ?, updated_at = ? WHERE id = ?`).bind(newEmployeeId, nowIso(), purchaseId).run();
  await db
    .prepare(`INSERT INTO purchase_attribution_history (purchase_id, previous_employee_id, new_employee_id, changed_by, reason) VALUES (?, ?, ?, ?, ?)`)
    .bind(purchaseId, existing.attributed_employee_id, newEmployeeId, changedBy, reason || null)
    .run();
  await logActivity(db, { actor: { id: changedBy }, action: 'ATTRIBUTION_CHANGED', entityType: 'customer', entityId: existing.customer_id, metadata: { purchaseId, from: existing.attributed_employee_id, to: newEmployeeId, reason } });
  await broadcast(env, 'PURCHASE_UPDATED', { customerId: existing.customer_id, purchaseId }, { scope: 'role', role: 'team_leader' });
  return await getPurchase(db, purchaseId);
}

// --- Future POS integration stubs (section 61/62) — never pretend to work. ---
export async function syncPOSPurchase() {
  throw httpError(501, 'POS integration is not configured for this deployment.', 'INTEGRATION_REQUIRED');
}
export async function syncFromPOS() {
  throw httpError(501, 'Automatic POS matching is not configured for this deployment.', 'INTEGRATION_REQUIRED');
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
