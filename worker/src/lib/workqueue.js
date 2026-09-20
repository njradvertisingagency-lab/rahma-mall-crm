// Smart priority queue (employee "Next Customers to Handle"), smart follow-up
// rule suggestions, and smart reassignment suggestions.
//
// Every rule here only ever SUGGESTS. Nothing in this file writes to the
// database or executes a reassignment/follow-up on its own — the Team Leader
// (or the employee, for their own queue) always takes the actual action
// through the existing, already-audited endpoints.
import { getEmployeePresenceMap, getPresenceThresholds } from './presence.js';

// Ranks an employee's open customers so the busiest/most-urgent ones surface
// first. Every signal used is real (priority flag, an actually-overdue
// follow-up row, actual status, actual last-updated time) — nothing here is
// randomized or guessed.
export async function getEmployeeWorkQueue(db, employeeId, limit = 20) {
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.status, c.priority, c.source, c.updated_at,
              CASE WHEN c.priority = 'URGENT' THEN 1 ELSE 0 END AS urgent_flag,
              CASE WHEN EXISTS (
                SELECT 1 FROM followups f
                WHERE f.customer_id = c.id AND (f.status = 'OVERDUE' OR (f.status IN ('UPCOMING', 'DUE') AND f.scheduled_for < datetime('now')))
              ) THEN 1 ELSE 0 END AS followup_overdue,
              CASE WHEN c.status = 'INTERESTED' THEN 1 ELSE 0 END AS interested_flag,
              (SELECT COUNT(*) FROM call_attempts ca WHERE ca.customer_id = c.id AND ca.outcome IN ('NO_ANSWER', 'SWITCHED_OFF', 'BUSY')
                AND ca.id > COALESCE((SELECT MAX(ca2.id) FROM call_attempts ca2 WHERE ca2.customer_id = c.id AND ca2.outcome = 'ANSWERED'), 0)
              ) AS consecutive_unanswered
       FROM customers c
       WHERE c.archived = 0 AND c.assigned_employee_id = ? AND c.status NOT IN ('CLOSED', 'NOT_INTERESTED')
       ORDER BY urgent_flag DESC, followup_overdue DESC, interested_flag DESC, c.updated_at ASC
       LIMIT ?`
    )
    .bind(employeeId, limit)
    .all();

  return rows.results.map((r) => {
    const reasons = [];
    if (r.urgent_flag) reasons.push('أولوية عاجلة');
    if (r.followup_overdue) reasons.push('متابعة متأخرة');
    if (r.interested_flag) reasons.push('عميل مهتم');
    if (r.consecutive_unanswered >= 3) reasons.push(`${r.consecutive_unanswered} محاولات اتصال بدون رد`);
    if (reasons.length === 0) reasons.push('مرتّب حسب الأقدم تحديثًا');
    return { ...r, reasons };
  });
}

// Suggest-only follow-up recommendations: customers with 3+ consecutive
// unanswered call attempts and no currently open follow-up scheduled.
// Never auto-creates a follow-up — the employee/TL must act on the suggestion.
export async function getFollowupSuggestions(db, employeeId = null) {
  const employeeFilter = employeeId ? 'AND c.assigned_employee_id = ?' : '';
  const binds = employeeId ? [employeeId] : [];
  const rows = await db
    .prepare(
      `SELECT * FROM (
         SELECT c.id AS customer_id, c.name, c.assigned_employee_id,
                (SELECT COUNT(*) FROM call_attempts ca WHERE ca.customer_id = c.id AND ca.outcome IN ('NO_ANSWER', 'SWITCHED_OFF', 'BUSY')
                  AND ca.id > COALESCE((SELECT MAX(ca2.id) FROM call_attempts ca2 WHERE ca2.customer_id = c.id AND ca2.outcome = 'ANSWERED'), 0)
                ) AS consecutive_unanswered
         FROM customers c
         WHERE c.archived = 0 AND c.status NOT IN ('CLOSED', 'NOT_INTERESTED') ${employeeFilter}
           AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.customer_id = c.id AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE'))
       ) sub
       WHERE consecutive_unanswered >= 3`
    )
    .bind(...binds)
    .all();

  return rows.results.map((r) => ({
    customerId: r.customer_id,
    customerName: r.name,
    employeeId: r.assigned_employee_id,
    consecutiveUnanswered: r.consecutive_unanswered,
    suggestion: `${r.consecutive_unanswered} محاولات اتصال بدون رد — يُنصح بجدولة متابعة`,
  }));
}

// Suggest-only reassignment candidates: employees who are offline / on a long
// break / racking up repeated SLA breaches while still holding open
// customers. Execution always requires the Team Leader to use the existing
// manual reassignment endpoint (POST /api/reassignments) — nothing here
// changes an assignment.
export async function getReassignmentSuggestions(db) {
  const [presenceMap, employees, breachRows] = await Promise.all([
    getEmployeePresenceMap(db),
    db.prepare(`SELECT id, name, availability FROM employees WHERE active = 1`).all(),
    db
      .prepare(
        `SELECT employee_id, COUNT(*) AS breach_count FROM sla_events
         WHERE level = 'BREACHED' AND resolved_at IS NULL AND employee_id IS NOT NULL
         GROUP BY employee_id HAVING breach_count >= 3`
      )
      .all(),
  ]);

  const suggestions = [];
  const breachByEmployee = Object.fromEntries(breachRows.results.map((r) => [r.employee_id, r.breach_count]));

  for (const e of employees.results) {
    const p = presenceMap[e.id] || { online: false, activityState: 'OFFLINE' };
    const isOfflineOrBreak = !p.online || e.availability === 'ON_BREAK' || e.availability === 'UNAVAILABLE';
    const hasBreaches = !!breachByEmployee[e.id];
    if (!isOfflineOrBreak && !hasBreaches) continue;

    const openCustomers = await db
      .prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0 AND status NOT IN ('CLOSED', 'NOT_INTERESTED')`)
      .bind(e.id)
      .first();
    if (openCustomers.n === 0) continue;

    const reasons = [];
    if (!p.online) reasons.push('غير متصل');
    else if (e.availability === 'ON_BREAK') reasons.push('في استراحة');
    else if (e.availability === 'UNAVAILABLE') reasons.push('غير متاح');
    if (hasBreaches) reasons.push(`${breachByEmployee[e.id]} تجاوز غير محلول لموعد الخدمة`);

    suggestions.push({
      employeeId: e.id,
      employeeName: e.name,
      openAssignedCustomers: openCustomers.n,
      reasons,
      note: 'اقتراح فقط — يتطلب موافقة قائد الفريق يدويًا.',
    });
  }
  return suggestions;
}
