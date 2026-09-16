import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { jsonError, nowIso, logActivity, broadcast } from '../lib/db.js';
import {
  createBranchVisit,
  createManualPurchase,
  getPurchase,
  updatePurchase,
  cancelPurchase,
  createRefund,
  getCustomerPurchases,
  getCustomerLifetimeValue,
  changeAttribution,
  getSalesSettings,
} from '../lib/sales.js';

export const salesRoutes = new Hono();
salesRoutes.use('*', requireAuth);

// Read-only, any authenticated user — the Purchase modal needs the configured
// payment method list regardless of role.
salesRoutes.get('/settings', async (c) => {
  const settings = await getSalesSettings(c.env.DB);
  return c.json({ settings });
});

async function loadCustomerForSale(db, user, customerId) {
  const customer = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return { error: { status: 404, message: 'Customer not found', code: 'NOT_FOUND' } };
  if (user.role === 'employee' && customer.assigned_employee_id !== user.employeeId) {
    return { error: { status: 403, message: 'Not your customer', code: 'FORBIDDEN_OWNERSHIP' } };
  }
  return { customer };
}

function handleServiceError(c, err) {
  if (err && err.status) return jsonError(c, err.status, err.message, err.code);
  console.error(err);
  return jsonError(c, 500, 'Unexpected error', 'INTERNAL');
}

// ---------------------------------------------------------------------------
// BRANCH MASTER DATA
// ---------------------------------------------------------------------------
salesRoutes.get('/branches', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, name, active FROM branches WHERE active = 1 ORDER BY name COLLATE NOCASE`).all();
  return c.json({ branches: rows.results });
});

salesRoutes.post('/branches', requireRole('team_leader'), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return jsonError(c, 400, 'Branch name is required', 'MISSING_NAME');
  const existing = await db.prepare(`SELECT id FROM branches WHERE name = ?`).bind(name).first();
  if (existing) return jsonError(c, 409, 'A branch with this name already exists', 'DUPLICATE_BRANCH');
  const res = await db.prepare(`INSERT INTO branches (name) VALUES (?) RETURNING id`).bind(name).first();
  await logActivity(db, { actor: c.get('user'), action: 'BRANCH_CREATED', entityType: 'branch', entityId: String(res.id), metadata: { name } });
  return c.json({ branch: { id: res.id, name, active: 1 } }, 201);
});

// ---------------------------------------------------------------------------
// PRODUCT CATALOG (lightweight; a free-typed product name is still accepted
// on a purchase line even if it's not in this catalog)
// ---------------------------------------------------------------------------
salesRoutes.get('/products', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, name, sku FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE`).all();
  return c.json({ products: rows.results });
});

// ---------------------------------------------------------------------------
// BRANCH VISITS — either the assigned employee or the Team Leader may log
// that a customer physically came in; this alone never implies a purchase.
// ---------------------------------------------------------------------------
salesRoutes.post('/customers/:id/branch-visits', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { customer, error } = await loadCustomerForSale(db, user, id);
  if (error) return jsonError(c, error.status, error.message, error.code);
  if (!body.branchId) return jsonError(c, 400, 'Branch is required', 'MISSING_BRANCH');

  try {
    const visit = await createBranchVisit(db, c.env, {
      customerId: id,
      employeeId: customer.assigned_employee_id ?? (user.role === 'employee' ? user.employeeId : null),
      branchId: Number(body.branchId),
      notes: body.notes,
      createdBy: user.id,
    });
    return c.json({ visit }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// ---------------------------------------------------------------------------
// DEAL DONE / PURCHASES — Team Leader only (spec: the Deal Done button is
// shown only to users with permission to record a purchase; in this system
// that permission belongs to the Team Leader role).
// ---------------------------------------------------------------------------
salesRoutes.post('/customers/:id/purchases', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const customer = await db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!customer) return jsonError(c, 404, 'Customer not found', 'NOT_FOUND');
  if (!body.branchId) return jsonError(c, 400, 'Branch is required', 'MISSING_BRANCH');
  if (!Array.isArray(body.items) || body.items.length === 0) return jsonError(c, 400, 'At least one product line is required', 'NO_ITEMS');
  for (const it of body.items) {
    if (!it.productName || !String(it.productName).trim()) return jsonError(c, 400, 'Each product line needs a product name', 'MISSING_PRODUCT_NAME');
  }

  try {
    const purchase = await createManualPurchase(db, c.env, {
      customerId: id,
      branchId: Number(body.branchId),
      purchaseAt: body.purchaseAt || nowIso(),
      invoiceNumber: body.invoiceNumber ? String(body.invoiceNumber).trim() : null,
      orderId: body.orderId ? String(body.orderId).trim() : null,
      items: body.items,
      paymentMethod: body.paymentMethod || 'CASH',
      notes: body.notes,
      attributedEmployeeId: body.attributedEmployeeId !== undefined ? (body.attributedEmployeeId === null ? null : Number(body.attributedEmployeeId)) : customer.assigned_employee_id,
      createdBy: user.id,
    });
    return c.json({ purchase }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

salesRoutes.get('/customers/:id/purchases', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  const { error } = await loadCustomerForSale(db, user, id);
  if (error) return jsonError(c, error.status, error.message, error.code);
  const [purchases, lifetimeValue] = await Promise.all([getCustomerPurchases(db, id), getCustomerLifetimeValue(db, id)]);
  return c.json({ purchases, lifetimeValue });
});

salesRoutes.get('/purchases/:purchaseId', async (c) => {
  const db = c.env.DB;
  const purchase = await getPurchase(db, Number(c.req.param('purchaseId')));
  if (!purchase) return jsonError(c, 404, 'Purchase not found', 'NOT_FOUND');
  const user = c.get('user');
  if (user.role === 'employee' && purchase.attributed_employee_id !== user.employeeId) {
    return jsonError(c, 403, 'Not your purchase', 'FORBIDDEN_OWNERSHIP');
  }
  return c.json({ purchase });
});

salesRoutes.patch('/purchases/:purchaseId', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const purchaseId = Number(c.req.param('purchaseId'));
  const body = await c.req.json().catch(() => ({}));
  try {
    const purchase = await updatePurchase(db, c.env, purchaseId, body, { changedBy: user.id, reason: body.reason });
    return c.json({ purchase });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

salesRoutes.post('/purchases/:purchaseId/cancel', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const purchaseId = Number(c.req.param('purchaseId'));
  const body = await c.req.json().catch(() => ({}));
  try {
    const purchase = await cancelPurchase(db, c.env, purchaseId, { cancelledBy: user.id, reason: body.reason });
    return c.json({ purchase });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

salesRoutes.post('/purchases/:purchaseId/refunds', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const purchaseId = Number(c.req.param('purchaseId'));
  const body = await c.req.json().catch(() => ({}));
  try {
    const purchase = await createRefund(db, c.env, purchaseId, {
      refundAmount: body.refundAmount,
      refundReason: body.refundReason,
      refundNotes: body.refundNotes,
      refundedBy: user.id,
    });
    return c.json({ purchase });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

salesRoutes.post('/purchases/:purchaseId/attribution', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const purchaseId = Number(c.req.param('purchaseId'));
  const body = await c.req.json().catch(() => ({}));
  if (body.newEmployeeId === undefined) return jsonError(c, 400, 'newEmployeeId is required', 'MISSING_EMPLOYEE');
  try {
    const purchase = await changeAttribution(db, c.env, purchaseId, {
      newEmployeeId: body.newEmployeeId === null ? null : Number(body.newEmployeeId),
      changedBy: user.id,
      reason: body.reason,
    });
    return c.json({ purchase });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
