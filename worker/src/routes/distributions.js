import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { nextDistributionLabel, logActivity, createNotification, broadcast, jsonError, nowIso } from '../lib/db.js';

export const distributionRoutes = new Hono();
distributionRoutes.use('*', requireAuth, requireRole('team_leader'));

async function getEligibleEmployees(db, requestedIds, onlyAvailable) {
  let rows;
  if (requestedIds && requestedIds.length) {
    const placeholders = requestedIds.map(() => '?').join(',');
    rows = await db.prepare(`SELECT * FROM employees WHERE active = 1 AND id IN (${placeholders})`).bind(...requestedIds).all();
  } else {
    rows = await db.prepare(`SELECT * FROM employees WHERE active = 1`).all();
  }
  let list = rows.results;
  if (onlyAvailable) list = list.filter((e) => e.availability === 'AVAILABLE');
  return list;
}

function planEqual(customerIds, employees) {
  // Contiguous fair blocks: remainder distributed one-extra to the first N employees.
  const n = employees.length;
  const base = Math.floor(customerIds.length / n);
  const remainder = customerIds.length % n;
  const plan = new Map(employees.map((e) => [e.id, []]));
  let idx = 0;
  employees.forEach((emp, i) => {
    const count = base + (i < remainder ? 1 : 0);
    for (let k = 0; k < count; k++) plan.get(emp.id).push(customerIds[idx++]);
  });
  return plan;
}

function planRoundRobin(customerIds, employees) {
  const plan = new Map(employees.map((e) => [e.id, []]));
  customerIds.forEach((cid, i) => {
    const emp = employees[i % employees.length];
    plan.get(emp.id).push(cid);
  });
  return plan;
}

distributionRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT * FROM distributions ORDER BY created_at DESC LIMIT 100`).all();
  return c.json({ distributions: rows.results });
});

distributionRoutes.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const dist = await db.prepare(`SELECT * FROM distributions WHERE id = ?`).bind(id).first();
  if (!dist) return jsonError(c, 404, 'Distribution not found', 'NOT_FOUND');
  const items = await db
    .prepare(
      `SELECT di.*, e.name AS employee_name FROM distribution_items di JOIN employees e ON e.id = di.employee_id WHERE di.distribution_id = ? ORDER BY e.name`
    )
    .bind(id)
    .all();
  const perEmployee = {};
  for (const item of items.results) {
    perEmployee[item.employee_name] = (perEmployee[item.employee_name] || 0) + 1;
  }
  return c.json({ distribution: dist, perEmployee, items: items.results });
});

distributionRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const method = body.method || 'EQUAL';
  if (!['EQUAL', 'ROUND_ROBIN', 'MANUAL'].includes(method)) return jsonError(c, 400, 'Invalid method', 'INVALID_METHOD');

  // 1. Resolve candidate customers.
  let customerIds = Array.isArray(body.customerIds) ? body.customerIds.slice() : [];
  if (body.selection === 'ALL_UNASSIGNED') {
    const rows = await db.prepare(`SELECT id FROM customers WHERE assigned_employee_id IS NULL AND archived = 0 ORDER BY created_at ASC`).all();
    customerIds = rows.results.map((r) => r.id);
  }
  if (customerIds.length === 0) return jsonError(c, 400, 'No customers selected for distribution', 'NO_CUSTOMERS');

  // Validate all customer ids exist and are not archived.
  const placeholders = customerIds.map(() => '?').join(',');
  const validRows = await db.prepare(`SELECT id FROM customers WHERE archived = 0 AND id IN (${placeholders})`).bind(...customerIds).all();
  const validSet = new Set(validRows.results.map((r) => r.id));
  customerIds = customerIds.filter((id) => validSet.has(id));
  if (customerIds.length === 0) return jsonError(c, 400, 'None of the selected customers are valid', 'NO_VALID_CUSTOMERS');

  let plan; // Map<employeeId, customerId[]>
  let employees;

  if (method === 'MANUAL') {
    const manual = body.manualAssignments || {};
    const employeeIds = [...new Set(Object.values(manual).map(Number))];
    employees = await getEligibleEmployees(db, employeeIds, false);
    if (employees.length === 0) return jsonError(c, 400, 'No valid employees in manual assignment', 'NO_EMPLOYEES');
    plan = new Map(employees.map((e) => [e.id, []]));
    for (const cid of customerIds) {
      const empId = Number(manual[cid]);
      if (plan.has(empId)) plan.get(empId).push(cid);
    }
  } else {
    const onlyAvailable = body.onlyAvailableEmployees !== false;
    employees = await getEligibleEmployees(db, body.employeeIds, onlyAvailable);
    if (employees.length === 0) {
      return jsonError(c, 400, 'No eligible (available) employees — select employees manually or mark some as AVAILABLE', 'NO_ELIGIBLE_EMPLOYEES');
    }
    plan = method === 'ROUND_ROBIN' ? planRoundRobin(customerIds, employees) : planEqual(customerIds, employees);
  }

  const totalAssigned = [...plan.values()].reduce((s, arr) => s + arr.length, 0);
  if (totalAssigned === 0) return jsonError(c, 400, 'Distribution plan is empty', 'EMPTY_PLAN');

  // 2. Create the distribution record, then apply all assignment mutations
  //    atomically via a single D1 batch so a failure never leaves a partial
  //    (inconsistent) distribution behind.
  const { label } = await nextDistributionLabel(db);
  const distRow = await db
    .prepare(`INSERT INTO distributions (label, method, total_customers, created_by, notes) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`)
    .bind(label, method, totalAssigned, user.id, body.notes || null)
    .first();
  const distributionId = distRow.id;
  const ts = nowIso();

  const statements = [];
  for (const [employeeId, ids] of plan) {
    for (const cid of ids) {
      statements.push(
        db.prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(employeeId, ts, ts, cid)
      );
      statements.push(
        db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason, distribution_id) VALUES (?, ?, ?, 'DISTRIBUTION', ?)`).bind(cid, employeeId, user.id, distributionId)
      );
      statements.push(db.prepare(`INSERT INTO distribution_items (distribution_id, employee_id, customer_id) VALUES (?, ?, ?)`).bind(distributionId, employeeId, cid));
    }
  }
  await db.batch(statements);

  await logActivity(db, {
    actor: user,
    action: 'DISTRIBUTION_CREATED',
    entityType: 'distribution',
    entityId: String(distributionId),
    metadata: { method, total: totalAssigned, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) },
  });

  // 3. Notify + broadcast to every affected employee, and the team leader.
  for (const [employeeId, ids] of plan) {
    if (ids.length === 0) continue;
    const emp = employees.find((e) => e.id === employeeId);
    await createNotification(db, {
      userId: emp.user_id,
      type: 'ASSIGNMENT',
      title: 'New customers assigned',
      message: `${ids.length} new customer${ids.length > 1 ? 's have' : ' has'} been assigned to you.`,
      entityType: 'distribution',
      entityId: String(distributionId),
    });
    await broadcast(c.env, 'CUSTOMER_ASSIGNED', { customerIds: ids, distributionId }, { scope: 'user', userId: emp.user_id });
    await broadcast(
      c.env,
      'NOTIFICATION_CREATED',
      { title: 'New customers assigned', message: `${ids.length} new customer${ids.length > 1 ? 's have' : ' has'} been assigned to you.` },
      { scope: 'user', userId: emp.user_id }
    );
  }
  await broadcast(c.env, 'DISTRIBUTION_COMPLETED', { distributionId, label, total: totalAssigned }, { scope: 'role', role: 'team_leader' });

  return c.json({ distribution: { id: distributionId, label, total: totalAssigned }, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) }, 201);
});

// ---------------------------------------------------------------------------
// REASSIGNMENT (mounted separately at /api/reassignments — see index.js)
// ---------------------------------------------------------------------------
export const reassignmentRoutes = new Hono();
reassignmentRoutes.use('*', requireAuth, requireRole('team_leader'));

reassignmentRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const customerIds = Array.isArray(body.customerIds) ? body.customerIds : [];
  if (customerIds.length === 0) return jsonError(c, 400, 'No customers selected', 'NO_SELECTION');

  if (body.mode === 'SPECIFIC_EMPLOYEE') {
    const employeeId = Number(body.employeeId);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ? AND active = 1`).bind(employeeId).first();
    if (!emp) return jsonError(c, 400, 'Invalid employee', 'INVALID_EMPLOYEE');

    const ts = nowIso();
    const statements = [];
    for (const cid of customerIds) {
      statements.push(db.prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(employeeId, ts, ts, cid));
      statements.push(db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason) VALUES (?, ?, ?, 'REASSIGNMENT')`).bind(cid, employeeId, user.id));
    }
    await db.batch(statements);

    await logActivity(db, { actor: user, action: 'CUSTOMER_REASSIGNED', entityType: 'customer', entityId: null, metadata: { customerIds, toEmployeeId: employeeId } });
    await createNotification(db, {
      userId: emp.user_id,
      type: 'REASSIGNMENT',
      title: 'Customers reassigned to you',
      message: `${customerIds.length} customer${customerIds.length > 1 ? 's were' : ' was'} reassigned to you.`,
    });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds, employeeId }, { scope: 'user', userId: emp.user_id });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds, employeeId }, { scope: 'role', role: 'team_leader' });
    return c.json({ ok: true, reassigned: customerIds.length });
  }

  if (body.mode === 'REDISTRIBUTE') {
    const onlyAvailable = body.onlyAvailableEmployees !== false;
    const employees = (await db.prepare(`SELECT * FROM employees WHERE active = 1`).all()).results.filter((e) => !onlyAvailable || e.availability === 'AVAILABLE');
    if (employees.length === 0) return jsonError(c, 400, 'No eligible employees to redistribute to', 'NO_ELIGIBLE_EMPLOYEES');
    const plan = planEqual(customerIds, employees);
    const ts = nowIso();
    const statements = [];
    for (const [employeeId, ids] of plan) {
      for (const cid of ids) {
        statements.push(db.prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(employeeId, ts, ts, cid));
        statements.push(db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason) VALUES (?, ?, ?, 'REASSIGNMENT')`).bind(cid, employeeId, user.id));
      }
    }
    if (statements.length) await db.batch(statements);
    for (const [employeeId, ids] of plan) {
      if (!ids.length) continue;
      const emp = employees.find((e) => e.id === employeeId);
      await createNotification(db, { userId: emp.user_id, type: 'REASSIGNMENT', title: 'Customers reassigned to you', message: `${ids.length} customer(s) reassigned to you.` });
      await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds: ids, employeeId }, { scope: 'user', userId: emp.user_id });
    }
    await logActivity(db, { actor: user, action: 'CUSTOMER_REASSIGNED', entityType: 'customer', entityId: null, metadata: { customerIds, mode: 'REDISTRIBUTE' } });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds }, { scope: 'role', role: 'team_leader' });
    return c.json({ ok: true, reassigned: customerIds.length, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) });
  }

  return jsonError(c, 400, 'mode must be SPECIFIC_EMPLOYEE or REDISTRIBUTE', 'INVALID_MODE');
});
