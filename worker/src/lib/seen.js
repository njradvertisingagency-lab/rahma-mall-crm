// Per-(customer, employee) "Seen" tracking. Recorded ONLY when an employee
// actually opens a customer's detail page while it is currently assigned to
// them — never on a list load, and never inferred. A customer reassigned to a
// new employee is automatically "not seen" for that employee: no special
// reset is needed, since the (customer_id, employee_id) pair for the new
// employee simply has no row yet. The previous employee's seen record is
// never deleted (historical fact — they DID see it, once).
import { nowIso, broadcast } from './db.js';

export async function recordSeenIfNeeded(db, env, { customerId, employeeId }) {
  const existing = await db.prepare(`SELECT seen_at FROM customer_seen WHERE customer_id = ? AND employee_id = ?`).bind(customerId, employeeId).first();
  if (existing) return { alreadySeen: true, seenAt: existing.seen_at };
  const now = nowIso();
  await db.prepare(`INSERT OR IGNORE INTO customer_seen (customer_id, employee_id, seen_at) VALUES (?, ?, ?)`).bind(customerId, employeeId, now).run();
  await broadcast(env, 'CUSTOMER_SEEN', { customerId, employeeId, seenAt: now }, { scope: 'role', role: 'team_leader' });
  return { alreadySeen: false, seenAt: now };
}

/** Full seen history for one customer (Customer 360 — "employee-specific seen"). */
export async function getCustomerSeenHistory(db, customerId) {
  const rows = await db
    .prepare(`SELECT cs.employee_id AS employeeId, e.name AS employeeName, cs.seen_at AS seenAt FROM customer_seen cs JOIN employees e ON e.id = cs.employee_id WHERE cs.customer_id = ? ORDER BY cs.seen_at ASC`)
    .bind(customerId)
    .all();
  return rows.results;
}

/** Whether the CURRENTLY assigned employee has seen this customer since the current assignment began. */
export async function isSeenByCurrentAssignee(db, customerId, assignedEmployeeId, assignedAt) {
  if (!assignedEmployeeId || !assignedAt) return null;
  const row = await db
    .prepare(`SELECT seen_at FROM customer_seen WHERE customer_id = ? AND employee_id = ? AND seen_at >= ?`)
    .bind(customerId, assignedEmployeeId, assignedAt)
    .first();
  return row ? row.seen_at : null;
}

/** Team Leader dashboard — Assigned/Seen/Not-Seen per employee (section 5). */
export async function getSeenSummaryByEmployee(db) {
  const rows = await db
    .prepare(
      `SELECT e.id AS employeeId, e.name AS employeeName, e.name_ar AS employeeNameAr,
         COUNT(c.id) AS assigned,
         SUM(CASE WHEN cs.customer_id IS NOT NULL THEN 1 ELSE 0 END) AS seen
       FROM employees e
       LEFT JOIN customers c ON c.assigned_employee_id = e.id AND c.archived = 0
       LEFT JOIN customer_seen cs ON cs.customer_id = c.id AND cs.employee_id = e.id AND cs.seen_at >= c.assigned_at
       WHERE e.active = 1
       GROUP BY e.id
       ORDER BY e.name COLLATE NOCASE`
    )
    .all();
  return rows.results.map((r) => ({ ...r, notSeen: r.assigned - r.seen }));
}

/** Drill-down: which of an employee's customers are currently not-seen. */
export async function getNotSeenCustomers(db, employeeId) {
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.normalized_phone AS normalizedPhone, c.status, c.priority, c.assigned_at AS assignedAt
       FROM customers c
       WHERE c.archived = 0 AND c.assigned_employee_id = ?
         AND NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)
       ORDER BY c.assigned_at ASC`
    )
    .bind(employeeId)
    .all();
  return rows.results;
}
