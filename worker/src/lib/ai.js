// A deliberately non-generative "AI Assistant": every answer is produced by
// running a real, auditable SQL query against D1 and formatting the result.
// There is no language model in the loop, so there is nothing for it to
// invent — a question that doesn't match a known, data-backed intent gets an
// explicit "not available" answer instead of a guess. This is the
// production-safe interpretation of section 45/46/47's "must not fabricate"
// requirement.

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function weekStart() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function monthStart() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function yesterdayRange() {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

const STATUS_WORDS = {
  new: 'NEW',
  calling: 'CALLING',
  'no answer': 'NO_ANSWER',
  busy: 'BUSY',
  'follow up': 'FOLLOW_UP',
  'follow-up': 'FOLLOW_UP',
  followup: 'FOLLOW_UP',
  interested: 'INTERESTED',
  'not interested': 'NOT_INTERESTED',
  closed: 'CLOSED',
};

async function findMentionedEmployee(db, question) {
  const employees = (await db.prepare(`SELECT id, name, user_id FROM employees`).all()).results;
  const lower = question.toLowerCase();
  return employees.find((e) => lower.includes(e.name.toLowerCase())) || null;
}

function findMentionedStatus(question) {
  const lower = question.toLowerCase();
  for (const [word, status] of Object.entries(STATUS_WORDS)) {
    if (lower.includes(word)) return status;
  }
  return null;
}

function timeWindowFromQuestion(question) {
  const lower = question.toLowerCase();
  if (lower.includes('today')) return { label: 'today', from: todayStart() };
  if (lower.includes('this week')) return { label: 'this week', from: weekStart() };
  if (lower.includes('this month')) return { label: 'this month', from: monthStart() };
  return null;
}

export async function answerQuestion(db, question, askingUser) {
  const q = String(question || '').trim();
  const lower = q.toLowerCase();
  const scopeEmployeeId = askingUser.role === 'employee' ? askingUser.employeeId : null;

  // 1. Overdue follow-ups by employee.
  if (lower.includes('overdue') && (lower.includes('which employee') || lower.includes('who has') || lower.includes('employees'))) {
    const rows = await db
      .prepare(
        `SELECT e.name, COUNT(*) AS n FROM followups f JOIN employees e ON e.id = f.employee_id WHERE (f.status = 'OVERDUE' OR (f.status = 'UPCOMING' AND f.scheduled_for < datetime('now'))) ${scopeEmployeeId ? 'AND f.employee_id = ?' : ''} GROUP BY e.name ORDER BY n DESC`
      )
      .bind(...(scopeEmployeeId ? [scopeEmployeeId] : []))
      .all();
    if (rows.results.length === 0) return { answer: 'No employees currently have overdue follow-ups.', grounded: true };
    return { answer: rows.results.map((r) => `${r.name}: ${r.n} overdue`).join(', '), grounded: true, data: rows.results };
  }

  // 2. Customers closed [today|this week|this month] [by <employee>].
  if (lower.includes('close') && (lower.includes('how many') || lower.includes('did'))) {
    const employee = await findMentionedEmployee(db, q);
    const window = timeWindowFromQuestion(q) || { label: 'all time', from: null };
    const conds = [`status = 'CLOSED'`, 'archived = 0'];
    const binds = [];
    if (window.from) {
      conds.push('closed_at >= ?');
      binds.push(window.from);
    }
    if (employee) {
      conds.push('assigned_employee_id = ?');
      binds.push(employee.id);
    } else if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    const who = employee ? employee.name : scopeEmployeeId ? 'you' : 'the team';
    return { answer: `${who === 'the team' ? 'The team' : who} closed ${row.n} customer(s) ${window.label}.`, grounded: true, data: { count: row.n } };
  }

  // 3. Unassigned customers.
  if (lower.includes('unassigned')) {
    if (scopeEmployeeId) return { answer: 'لا توجد بيانات كافية للإجابة — that information is not available in the current dataset.', grounded: true };
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id IS NULL AND archived = 0`).first();
    return { answer: `There are currently ${row.n} unassigned customers.`, grounded: true, data: { count: row.n } };
  }

  // 4. Customers currently in a given status.
  const status = findMentionedStatus(q);
  if (status && (lower.includes('how many') || lower.includes('currently'))) {
    const conds = [`status = ?`, 'archived = 0'];
    const binds = [status];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `There are ${row.n} customer(s) currently in ${status.replace('_', ' ')}.`, grounded: true, data: { count: row.n } };
  }

  // 5. Customers assigned yesterday that haven't been updated since.
  if (lower.includes('yesterday') && (lower.includes("haven't been updated") || lower.includes('not been updated') || lower.includes('not updated'))) {
    const { start, end } = yesterdayRange();
    const conds = ['assigned_at BETWEEN ? AND ?', 'updated_at <= assigned_at', 'archived = 0'];
    const binds = [start, end];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const rows = await db.prepare(`SELECT id, phone, name FROM customers WHERE ${conds.join(' AND ')} LIMIT 50`).bind(...binds).all();
    if (rows.results.length === 0) return { answer: 'No customers assigned yesterday are missing an update.', grounded: true };
    return { answer: `${rows.results.length} customer(s) assigned yesterday have not been updated: ${rows.results.map((r) => r.id).join(', ')}`, grounded: true, data: rows.results };
  }

  // 6. Daily / team performance summary.
  if (lower.includes('summar') && (lower.includes('today') || lower.includes('team') || lower.includes('performance'))) {
    const summary = await generateDailySummary(db);
    return { answer: formatSummaryText(summary), grounded: true, data: summary };
  }

  // 7. Total customers. (Excludes more specific "not seen" questions, handled by intent 10.)
  if ((lower.includes('how many customers') || lower.includes('total customers')) && !lower.includes('not seen') && !lower.includes('not been seen') && !lower.includes('unseen')) {
    const conds = ['archived = 0'];
    const binds = [];
    if (scopeEmployeeId) {
      conds.push('assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `There are ${row.n} customers in total${scopeEmployeeId ? ' assigned to you' : ''}.`, grounded: true, data: { count: row.n } };
  }

  // 8. Average response time.
  if (lower.includes('average response') || lower.includes('response time')) {
    const conds = [`h.from_status = 'NEW'`, 'c.assigned_at IS NOT NULL'];
    const binds = [];
    if (scopeEmployeeId) {
      conds.push('c.assigned_employee_id = ?');
      binds.push(scopeEmployeeId);
    }
    const row = await db
      .prepare(
        `SELECT AVG((julianday(h.changed_at) - julianday(c.assigned_at)) * 24 * 60) AS avg_minutes
         FROM customer_status_history h JOIN customers c ON c.id = h.customer_id WHERE ${conds.join(' AND ')}`
      )
      .bind(...binds)
      .first();
    if (row.avg_minutes == null) return { answer: 'لا توجد بيانات كافية للإجابة — that information is not available in the current dataset.', grounded: true };
    return { answer: `Average first-response time is ${Math.round(row.avg_minutes)} minutes.`, grounded: true, data: { avgMinutes: row.avg_minutes } };
  }

  // 9. Reopened today.
  if (lower.includes('reopen')) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(todayStart()).first();
    return { answer: `${row.n} customer(s) were reopened today.`, grounded: true, data: { count: row.n } };
  }

  // 10. Not-seen customers.
  if (lower.includes('not seen') || lower.includes('not been seen') || lower.includes('unseen')) {
    const conds = [`c.archived = 0`, `c.assigned_employee_id IS NOT NULL`, `NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)`];
    const binds = [];
    if (scopeEmployeeId) { conds.push('c.assigned_employee_id = ?'); binds.push(scopeEmployeeId); }
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    return { answer: `${row.n} customer(s) have not been seen yet.`, grounded: true, data: { count: row.n } };
  }

  // 11. SLA breaches.
  if (lower.includes('sla') && (lower.includes('breach') || lower.includes('how many') || lower.includes('warning'))) {
    const { getSlaCounts } = await import('./sla.js');
    const counts = await getSlaCounts(db);
    return { answer: `${counts.breached} SLA breach(es) and ${counts.warning} SLA warning(s) across ${counts.customersAffected} customer(s).`, grounded: true, data: counts };
  }

  // 12. Lead score for a specific customer (by ID).
  const custIdMatch = q.match(/RM-\d+/i);
  if (custIdMatch && lower.includes('lead score')) {
    const { computeLeadScore } = await import('./leadscore.js');
    const id = custIdMatch[0].toUpperCase();
    const customer = await db.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
    if (!customer) return { answer: 'لا توجد بيانات كافية للإجابة — that customer was not found.', grounded: true };
    const { score, reasons } = await computeLeadScore(db, id);
    return { answer: `${id} has a lead score of ${score}. Reasons: ${reasons.map((r) => r.label).join(', ') || 'none yet'}.`, grounded: true, data: { score, reasons } };
  }

  // 13. Campaign performance.
  if (lower.includes('campaign')) {
    const words = q.split(/\s+/);
    const campaignRow = await db.prepare(`SELECT DISTINCT campaign FROM customers WHERE campaign IS NOT NULL`).all();
    const mentioned = campaignRow.results.find((r) => lower.includes(String(r.campaign).toLowerCase()));
    if (mentioned) {
      const [leads, deals, revenue] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE campaign = ? AND archived = 0`).bind(mentioned.campaign).first(),
        db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.campaign = ? AND EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = c.id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`).bind(mentioned.campaign).first(),
        db.prepare(`SELECT COALESCE(SUM(p.total_amount - p.refunded_amount),0) AS net FROM purchase_transactions p JOIN customers c ON c.id = p.customer_id WHERE c.campaign = ? AND p.status != 'CANCELLED'`).bind(mentioned.campaign).first(),
      ]);
      return { answer: `Campaign "${mentioned.campaign}": ${leads.n} lead(s), ${deals.n} deal(s), ${Math.round(revenue.net)} EGP net revenue.`, grounded: true, data: { leads: leads.n, deals: deals.n, netRevenue: revenue.net } };
    }
  }

  // 14. Deals / sales today.
  if ((lower.includes('deal') || lower.includes('sale')) && lower.includes('today')) {
    const today = todayStart();
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE purchase_at >= ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(today).first();
    return { answer: `${row.n} deal(s) done today, net revenue ${Math.round(row.net)} EGP.`, grounded: true, data: { deals: row.n, netRevenue: row.net } };
  }

  // 15. Total sales / net revenue (all time or a window).
  if (lower.includes('total sales') || lower.includes('net revenue') || (lower.includes('revenue') && lower.includes('how much'))) {
    const window = timeWindowFromQuestion(q);
    const conds = [`status != 'CANCELLED'`];
    const binds = [];
    if (window?.from) { conds.push('purchase_at >= ?'); binds.push(window.from); }
    const row = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS gross, COALESCE(SUM(refunded_amount),0) AS refunds FROM purchase_transactions WHERE ${conds.join(' AND ')}`).bind(...binds).first();
    const net = Math.round((row.gross - row.refunds) * 100) / 100;
    return { answer: `Net revenue${window ? ' ' + window.label : ''}: ${net} EGP (gross ${Math.round(row.gross)}, refunds ${Math.round(row.refunds)}).`, grounded: true, data: { gross: row.gross, refunds: row.refunds, net } };
  }

  // 16. Branch visits without a purchase (spec: explicit metric, not inferred).
  if (lower.includes('branch visit') && (lower.includes('no purchase') || lower.includes('without') || lower.includes('did not buy') || lower.includes("didn't buy"))) {
    const row = await db
      .prepare(
        `SELECT COUNT(DISTINCT bv.customer_id) AS n FROM customer_branch_visits bv
         WHERE NOT EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = bv.customer_id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`
      )
      .first();
    return { answer: `${row.n} customer(s) visited a branch but have not made a purchase.`, grounded: true, data: { count: row.n } };
  }

  // 17. Refunds.
  if (lower.includes('refund')) {
    const window = timeWindowFromQuestion(q);
    const conds = [];
    const binds = [];
    if (window?.from) { conds.push('created_at >= ?'); binds.push(window.from); }
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(refund_amount),0) AS total FROM purchase_refunds ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}`).bind(...binds).first();
    return { answer: `${row.n} refund(s)${window ? ' ' + window.label : ''} totaling ${Math.round(row.total)} EGP.`, grounded: true, data: { count: row.n, total: row.total } };
  }

  // 18. Per-employee sales.
  const salesEmployee = await findMentionedEmployee(db, q);
  if (salesEmployee && (lower.includes('sale') || lower.includes('deal') || lower.includes('revenue'))) {
    const row = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE attributed_employee_id = ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(salesEmployee.id).first();
    return { answer: `${salesEmployee.name} has ${row.n} deal(s) attributed, net revenue ${Math.round(row.net)} EGP.`, grounded: true, data: { deals: row.n, netRevenue: row.net } };
  }

  // 19. Top products.
  if (lower.includes('top product') || (lower.includes('best sell') || lower.includes('bestsell'))) {
    const rows = await db
      .prepare(`SELECT product_name, SUM(quantity) AS qty, COUNT(DISTINCT purchase_id) AS orders FROM purchase_items GROUP BY product_name ORDER BY qty DESC LIMIT 5`)
      .all();
    if (rows.results.length === 0) return { answer: 'لا توجد بيانات كافية للإجابة — no purchase items recorded yet.', grounded: true };
    return { answer: 'Top products: ' + rows.results.map((r) => `${r.product_name} (${r.qty} units, ${r.orders} orders)`).join(', '), grounded: true, data: rows.results };
  }

  return { answer: 'لا توجد بيانات كافية للإجابة — that information is not available in the current dataset.', grounded: true };
}

export async function generateDailySummary(db) {
  const today = todayStart();
  const [total, assigned, unassigned, closedToday, interested, followUp, overdue, reopenedToday, sla, sales] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NOT NULL`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NULL`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND closed_at >= ?`).bind(today).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND status = 'INTERESTED'`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND status = 'FOLLOW_UP'`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')))`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(today).first(),
    import('./sla.js').then((m) => m.getSlaCounts(db)),
    db.prepare(`SELECT COUNT(*) AS deals, COALESCE(SUM(total_amount - refunded_amount),0) AS net FROM purchase_transactions WHERE purchase_at >= ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(today).first(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    timeRange: 'today (since ' + today + ')',
    totalCustomers: total.n,
    assigned: assigned.n,
    unassigned: unassigned.n,
    closedToday: closedToday.n,
    interested: interested.n,
    followUp: followUp.n,
    overdue: overdue.n,
    reopenedToday: reopenedToday.n,
    slaBreaches: sla.breached,
    slaWarnings: sla.warning,
    dealsToday: sales.deals,
    netRevenueToday: Math.round(sales.net * 100) / 100,
  };
}

function formatSummaryText(s) {
  return (
    `Team summary — ${s.totalCustomers} total customers (${s.assigned} assigned, ${s.unassigned} unassigned). ` +
    `${s.closedToday} closed today, ${s.interested} interested, ${s.followUp} in follow-up, ${s.overdue} overdue follow-ups, ${s.reopenedToday} reopened today. ` +
    `SLA: ${s.slaBreaches} breach(es), ${s.slaWarnings} warning(s). Sales: ${s.dealsToday} deal(s) today, ${s.netRevenueToday} EGP net revenue today.`
  );
}

// Every insight carries its own supportingData and timeRange so it is never
// presented as a bare assertion — the Team Leader can always see exactly
// which numbers produced it (spec: never assert as fact without enough data).
export async function generateOperationalInsights(db) {
  const insights = [];
  const now = new Date().toISOString();

  const staleRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND updated_at <= datetime('now','-24 hours') AND status NOT IN ('CLOSED')`)
    .first();
  if (staleRow.n > 0) insights.push({ text: `${staleRow.n} customers have not been updated for more than 24 hours.`, supportingData: { count: staleRow.n }, timeRange: 'last 24 hours', generatedAt: now });

  const overdueRow = await db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now')))`).first();
  if (overdueRow.n > 0) insights.push({ text: `${overdueRow.n} follow-ups are overdue.`, supportingData: { count: overdueRow.n }, timeRange: 'as of now', generatedAt: now });

  const unassignedRow = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NULL`).first();
  if (unassignedRow.n > 0) insights.push({ text: `${unassignedRow.n} customers remain unassigned.`, supportingData: { count: unassignedRow.n }, timeRange: 'as of now', generatedAt: now });

  const reopenedRow = await db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'CUSTOMER_REOPENED' AND created_at >= ?`).bind(todayStart()).first();
  if (reopenedRow.n > 0) insights.push({ text: `${reopenedRow.n} customers were reopened today.`, supportingData: { count: reopenedRow.n }, timeRange: 'today', generatedAt: now });

  const unavailableRow = await db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND availability != 'AVAILABLE'`).first();
  if (unavailableRow.n > 0) insights.push({ text: `${unavailableRow.n} employees are currently not available.`, supportingData: { count: unavailableRow.n }, timeRange: 'as of now', generatedAt: now });

  const { getSlaCounts } = await import('./sla.js');
  const slaCounts = await getSlaCounts(db);
  if (slaCounts.breached > 0) insights.push({ text: `${slaCounts.breached} customer(s) are currently in SLA breach.`, supportingData: slaCounts, timeRange: 'as of now', generatedAt: now });

  const noPurchaseVisitRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT bv.customer_id) AS n FROM customer_branch_visits bv
       WHERE NOT EXISTS (SELECT 1 FROM purchase_transactions p WHERE p.customer_id = bv.customer_id AND p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED'))`
    )
    .first();
  if (noPurchaseVisitRow.n > 0) insights.push({ text: `${noPurchaseVisitRow.n} customer(s) visited a branch but have not purchased.`, supportingData: { count: noPurchaseVisitRow.n }, timeRange: 'all time', generatedAt: now });

  if (insights.length === 0) insights.push({ text: 'No operational issues detected from current data.', supportingData: {}, timeRange: 'as of now', generatedAt: now });
  return insights;
}
