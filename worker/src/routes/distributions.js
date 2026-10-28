import { Hono } from 'hono';
import { requireAuth, requireSalesLead } from '../lib/auth.js';
import { nextDistributionLabel, logActivity, broadcast, jsonError, nowIso, selectByIds } from '../lib/db.js';
import { getCairoNow, getCairoDayBoundsUtc } from '../lib/workhours.js';
import { protectedFirst, computeQuotas } from '../lib/protected.js';

export const distributionRoutes = new Hono();
distributionRoutes.use('*', requireAuth, requireSalesLead);

async function getEligibleEmployees(db, requestedIds, onlyAvailable) {
  let list;
  if (requestedIds && requestedIds.length) {
    list = await selectByIds(db, { table: 'employees', ids: requestedIds, extraWhereSql: 'active = 1' });
  } else {
    list = (await db.prepare(`SELECT * FROM employees WHERE active = 1`).all()).results;
  }
  if (onlyAvailable) list = list.filter((e) => e.availability === 'AVAILABLE');
  return protectedFirst(list); // كل الموظفين متساوين — الترتيب لا يُغير الحصص.
}

function planEqual(customerIds, employees) {
  // Contiguous blocks بالتساوي على جميع الموظفين.
  const quotas = computeQuotas(customerIds.length, employees.map((e) => e.id));
  const plan = new Map(employees.map((e) => [e.id, []]));
  let idx = 0;
  employees.forEach((emp) => {
    const count = quotas.get(Number(emp.id)) || 0;
    for (let k = 0; k < count; k++) plan.get(emp.id).push(customerIds[idx++]);
  });
  return plan;
}

function planRoundRobin(customerIds, employees) {
  const quotas = computeQuotas(customerIds.length, employees.map((e) => e.id));
  const remaining = new Map(employees.map((e) => [e.id, quotas.get(Number(e.id)) || 0]));
  const plan = new Map(employees.map((e) => [e.id, []]));
  let i = 0;
  customerIds.forEach((cid) => {
    for (let t = 0; t < employees.length; t++) {
      const emp = employees[i++ % employees.length];
      if (remaining.get(emp.id) > 0) {
        remaining.set(emp.id, remaining.get(emp.id) - 1);
        plan.get(emp.id).push(cid);
        return;
      }
    }
  });
  return plan;
}

// ---------------------------------------------------------------------------
// TODAY'S DISTRIBUTED CUSTOMERS — طلب أ/ هاني: صفحة لقائد الفريق تجمّع كل
// الأرقام اللي اتوزّعت النهاردة (لأي موظف) في مكان واحد، عشان يقدر يتواصل
// معاهم هو كمان كدعم إضافي للموظف المسؤول — بدون ما تتغيّر نسبة العميل ولا
// حسابات المكافآت (قراءة فقط، مفيش تعديل على assigned_employee_id هنا).
// ---------------------------------------------------------------------------
distributionRoutes.get('/today', async (c) => {
  const db = c.env.DB;
  const { dateStr } = getCairoNow();
  const { dayStartIso, dayEndIso } = getCairoDayBoundsUtc(dateStr);
  const rows = await db
    .prepare(
      `SELECT
         c.id, c.phone, c.normalized_phone, c.name, c.status, c.priority,
         c.whatsapp_contact_status, c.assigned_at, c.next_follow_up_at, c.updated_at,
         c.assigned_employee_id, e.name AS employee_name,
         (SELECT n.note FROM customer_notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS last_note,
         (SELECT n.created_at FROM customer_notes n WHERE n.customer_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS last_note_at
       FROM customers c
       LEFT JOIN employees e ON e.id = c.assigned_employee_id
       WHERE c.assigned_at >= ? AND c.assigned_at <= ? AND c.archived = 0
       ORDER BY c.assigned_at DESC`
    )
    .bind(dayStartIso, dayEndIso)
    .all();
  const customers = rows.results.map((r) => ({
    id: r.id,
    phone: r.phone,
    normalizedPhone: r.normalized_phone,
    name: r.name,
    status: r.status,
    priority: r.priority,
    whatsappContactStatus: r.whatsapp_contact_status,
    assignedAt: r.assigned_at,
    nextFollowUpAt: r.next_follow_up_at,
    updatedAt: r.updated_at,
    assignedEmployeeId: r.assigned_employee_id,
    employeeName: r.employee_name,
    lastNote: r.last_note,
    lastNoteAt: r.last_note_at,
  }));
  return c.json({ date: dateStr, total: customers.length, customers });
});

distributionRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT * FROM distributions ORDER BY created_at DESC LIMIT 100`).all();
  return c.json({ distributions: rows.results });
});

distributionRoutes.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const dist = await db.prepare(`SELECT * FROM distributions WHERE id = ?`).bind(id).first();
  if (!dist) return jsonError(c, 404, 'التوزيع غير موجود', 'NOT_FOUND');
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
  if (!['EQUAL', 'ROUND_ROBIN', 'MANUAL'].includes(method)) return jsonError(c, 400, 'طريقة غير صالحة', 'INVALID_METHOD');

  // 1. Resolve candidate customers.
  let customerIds = Array.isArray(body.customerIds) ? body.customerIds.slice() : [];
  if (body.selection === 'ALL_UNASSIGNED') {
    const rows = await db.prepare(`SELECT id FROM customers WHERE assigned_employee_id IS NULL AND archived = 0 ORDER BY created_at ASC`).all();
    customerIds = rows.results.map((r) => r.id);
  }
  if (customerIds.length === 0) return jsonError(c, 400, 'لم يتم اختيار عملاء للتوزيع', 'NO_CUSTOMERS');

  // Validate all customer ids exist and are not archived. Uses json_each (via
  // selectByIds) rather than one bound '?' per id, since D1 rejects a single
  // statement with more than 100 bound parameters — a limit a large
  // distribution batch easily exceeds.
// بطلب صاحب الشركة: الأرقام المعيّنة لموظف لا تُوزَّع أبداً — التوزيع للغير-موزَّعين فقط.
  const validRows = await selectByIds(db, { table: 'customers', selectSql: 'id', ids: customerIds, extraWhereSql: 'archived = 0 AND assigned_employee_id IS NULL' });
  const validSet = new Set(validRows.map((r) => r.id));
  customerIds = customerIds.filter((id) => validSet.has(id));
  if (customerIds.length === 0) return jsonError(c, 400, 'لا يوجد عميل غير موزّع ضمن المحددين — الأرقام المعيّنة لموظف لا تُنقل', 'NO_UNASSIGNED_CUSTOMERS');

  let plan; // Map<employeeId, customerId[]>
  let employees;
  let returnedToPrevious = 0; // عدد الأرقام المكررة اللي رجعت لنفس الموظف

  if (method === 'MANUAL') {
    const manual = body.manualAssignments || {};
    const employeeIds = [...new Set(Object.values(manual).map(Number))];
    employees = await getEligibleEmployees(db, employeeIds, false);
    if (employees.length === 0) return jsonError(c, 400, 'لا يوجد موظف صالح في التعيين اليدوي', 'NO_EMPLOYEES');
    plan = new Map(employees.map((e) => [e.id, []]));
    for (const cid of customerIds) {
      const empId = Number(manual[cid]);
      if (plan.has(empId)) plan.get(empId).push(cid);
    }
  } else {
    const onlyAvailable = body.onlyAvailableEmployees !== false;
    employees = await getEligibleEmployees(db, body.employeeIds, onlyAvailable);
    if (employees.length === 0) {
      return jsonError(c, 400, 'لا يوجد موظف متاح — اختر الموظفين يدويًا أو حدد بعضهم كـ"متاح"', 'NO_ELIGIBLE_EMPLOYEES');
    }

    // ── Duplicate routing: customers that were previously assigned to an
    //    employee get routed back to the SAME employee instead of being
    //    distributed to someone new. We look up the most recent non-null
    //    assignment from customer_assignments for each customer. ──
    const eligibleSet = new Set(employees.map((e) => e.id));
    const previousAssignments = await selectByIds(db, {
      table: 'customer_assignments',
      selectSql: 'customer_id, employee_id',
      ids: customerIds,
      idColumn: 'customer_id',
      extraWhereSql: 'employee_id IS NOT NULL',
    });
    // Build map: customer_id → last assigned employee (latest id = latest row).
    const prevMap = new Map();
    for (const row of previousAssignments) {
      prevMap.set(row.customer_id, row.employee_id);
    }

    // Split: customers with a previous eligible employee vs truly new ones.
    const returnIds = [];   // routed back to previous employee
    const freshIds = [];    // distributed normally
    plan = new Map(employees.map((e) => [e.id, []]));
    for (const cid of customerIds) {
      const prevEmp = prevMap.get(cid);
      if (prevEmp && eligibleSet.has(prevEmp)) {
        plan.get(prevEmp).push(cid);
        returnIds.push(cid);
        returnedToPrevious++;
      } else {
        freshIds.push(cid);
      }
    }

    // Distribute only the fresh (non-duplicate) customers equally/round-robin.
    if (freshIds.length > 0) {
      const freshPlan = method === 'ROUND_ROBIN' ? planRoundRobin(freshIds, employees) : planEqual(freshIds, employees);
      for (const [empId, ids] of freshPlan) {
        plan.get(empId).push(...ids);
      }
    }
  }

  const totalAssigned = [...plan.values()].reduce((s, arr) => s + arr.length, 0);
  if (totalAssigned === 0) return jsonError(c, 400, 'خطة التوزيع فارغة', 'EMPTY_PLAN');

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
    metadata: { method, total: totalAssigned, returnedToPrevious, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) },
  });

  // 3. Notify + broadcast to every affected employee, and the team leader.
  for (const [employeeId, ids] of plan) {
    if (ids.length === 0) continue;
    const emp = employees.find((e) => e.id === employeeId);
    await broadcast(c.env, 'CUSTOMER_ASSIGNED', { customerIds: ids, distributionId }, { scope: 'user', userId: emp.user_id });
  }
  await broadcast(c.env, 'DISTRIBUTION_COMPLETED', { distributionId, label, total: totalAssigned }, { scope: 'role', role: 'team_leader' });

  return c.json({ distribution: { id: distributionId, label, total: totalAssigned, returnedToPrevious }, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) }, 201);
});

// ---------------------------------------------------------------------------
// REASSIGNMENT (mounted separately at /api/reassignments — see index.js)
// ---------------------------------------------------------------------------
export const reassignmentRoutes = new Hono();
reassignmentRoutes.use('*', requireAuth, requireSalesLead);

reassignmentRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const customerIds = Array.isArray(body.customerIds) ? body.customerIds : [];
  if (customerIds.length === 0) return jsonError(c, 400, 'لم يتم اختيار عملاء', 'NO_SELECTION');

  if (body.mode === 'SPECIFIC_EMPLOYEE') {
    const employeeId = Number(body.employeeId);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ? AND active = 1`).bind(employeeId).first();
    if (!emp) return jsonError(c, 400, 'موظف غير صالح', 'INVALID_EMPLOYEE');

    const ts = nowIso();
    const statements = [];
    for (const cid of customerIds) {
      statements.push(db.prepare(`UPDATE customers SET assigned_employee_id = ?, assigned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(employeeId, ts, ts, cid));
      statements.push(db.prepare(`INSERT INTO customer_assignments (customer_id, employee_id, assigned_by, reason) VALUES (?, ?, ?, 'REASSIGNMENT')`).bind(cid, employeeId, user.id));
    }
    await db.batch(statements);

    await logActivity(db, { actor: user, action: 'CUSTOMER_REASSIGNED', entityType: 'customer', entityId: null, metadata: { customerIds, toEmployeeId: employeeId } });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds, employeeId }, { scope: 'user', userId: emp.user_id });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds, employeeId }, { scope: 'role', role: 'team_leader' });
    return c.json({ ok: true, reassigned: customerIds.length });
  }

  if (body.mode === 'REDISTRIBUTE') {
    const onlyAvailable = body.onlyAvailableEmployees !== false;
    const employees = (await db.prepare(`SELECT * FROM employees WHERE active = 1`).all()).results.filter((e) => !onlyAvailable || e.availability === 'AVAILABLE');
    employees.splice(0, employees.length, ...protectedFirst(employees));
    if (employees.length === 0) return jsonError(c, 400, 'لا يوجد موظف مؤهل لإعادة التوزيع إليه', 'NO_ELIGIBLE_EMPLOYEES');
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
      await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds: ids, employeeId }, { scope: 'user', userId: emp.user_id });
    }
    await logActivity(db, { actor: user, action: 'CUSTOMER_REASSIGNED', entityType: 'customer', entityId: null, metadata: { customerIds, mode: 'REDISTRIBUTE' } });
    await broadcast(c.env, 'CUSTOMER_REASSIGNED', { customerIds }, { scope: 'role', role: 'team_leader' });
    return c.json({ ok: true, reassigned: customerIds.length, perEmployee: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])) });
  }

  return jsonError(c, 400, 'يجب أن يكون الوضع تعيين موظف محدد أو إعادة توزيع', 'INVALID_MODE');
});
