import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { computeAllEmployeeStats } from '../lib/performance.js';
import { getSeenSummaryByEmployee } from '../lib/seen.js';
import { getSlaRules, findSeenSlaCandidates, findContactSlaCandidates, findInterestedFollowupSlaCandidates } from '../lib/sla.js';
import { computeLeadScore, getLeadScoreWeights } from '../lib/leadscore.js';
import { getCustomerLifetimeValue } from '../lib/sales.js';

export const reportRoutes = new Hono();
reportRoutes.use('*', requireAuth, requireRole('team_leader'));

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  return [header, ...lines].join('\r\n');
}

function csvResponse(c, filename, csv) {
  return new Response('﻿' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

function dateRangeFilter(q) {
  const conds = [];
  const binds = [];
  if (q.dateFrom) {
    conds.push('created_at >= ?');
    binds.push(q.dateFrom);
  }
  if (q.dateTo) {
    conds.push('created_at <= ?');
    binds.push(q.dateTo);
  }
  return { conds, binds };
}

reportRoutes.get('/customers', async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['c.archived = 0'];
  const binds = [];
  if (q.status) {
    conds.push('c.status = ?');
    binds.push(q.status);
  }
  if (q.employeeId) {
    conds.push('c.assigned_employee_id = ?');
    binds.push(Number(q.employeeId));
  }
  const dr = dateRangeFilter(q);
  conds.push(...dr.conds.map((x) => 'c.' + x));
  binds.push(...dr.binds);

  const rows = await db
    .prepare(`SELECT c.*, e.name AS employee_name FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id WHERE ${conds.join(' AND ')} ORDER BY c.created_at DESC`)
    .bind(...binds)
    .all();

  const csv = toCsv(rows.results, [
    { label: 'Customer ID', value: 'id' },
    { label: 'Phone', value: 'phone' },
    { label: 'Name', value: 'name' },
    { label: 'Assigned Employee', value: 'employee_name' },
    { label: 'Status', value: 'status' },
    { label: 'Priority', value: 'priority' },
    { label: 'Source', value: 'source' },
    { label: 'Campaign', value: 'campaign' },
    { label: 'Created At', value: 'created_at' },
    { label: 'Assigned At', value: 'assigned_at' },
    { label: 'Last Updated', value: 'updated_at' },
    { label: 'Next Follow-up', value: 'next_follow_up_at' },
    { label: 'Closed At', value: 'closed_at' },
    { label: 'Closed Reason', value: 'closed_reason' },
  ]);
  return csvResponse(c, `customers-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/employees', async (c) => {
  const db = c.env.DB;
  const { stats } = await computeAllEmployeeStats(db);
  const csv = toCsv(stats, [
    { label: 'Employee', value: (r) => r.employee.name },
    { label: 'Assigned', value: 'assigned' },
    { label: 'Closed', value: 'closed' },
    { label: 'Interested', value: 'interested' },
    { label: 'Follow-ups Total', value: 'followupsTotal' },
    { label: 'Follow-ups Completed', value: 'followupsCompleted' },
    { label: 'Follow-ups Overdue', value: 'followupsOverdue' },
    { label: 'Completion Rate', value: (r) => (r.completionRate * 100).toFixed(1) + '%' },
    { label: 'Performance Score', value: 'performanceScore' },
  ]);
  return csvResponse(c, `employee-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/activity', async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['1=1'];
  const binds = [];
  const dr = dateRangeFilter(q);
  conds.push(...dr.conds);
  binds.push(...dr.binds);
  const rows = await db.prepare(`SELECT * FROM activity_logs WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 5000`).bind(...binds).all();
  const csv = toCsv(rows.results, [
    { label: 'Timestamp', value: 'created_at' },
    { label: 'Actor', value: 'actor_name' },
    { label: 'Role', value: 'actor_role' },
    { label: 'Action', value: 'action' },
    { label: 'Entity Type', value: 'entity_type' },
    { label: 'Entity ID', value: 'entity_id' },
    { label: 'Metadata', value: 'metadata' },
  ]);
  return csvResponse(c, `activity-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/followups', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT f.*, e.name AS employee_name, c.name AS customer_name, c.phone FROM followups f LEFT JOIN employees e ON e.id = f.employee_id LEFT JOIN customers c ON c.id = f.customer_id ORDER BY f.scheduled_for DESC LIMIT 5000`)
    .all();
  const csv = toCsv(rows.results, [
    { label: 'Customer ID', value: 'customer_id' },
    { label: 'Customer', value: 'customer_name' },
    { label: 'Phone', value: 'phone' },
    { label: 'Employee', value: 'employee_name' },
    { label: 'Scheduled For', value: 'scheduled_for' },
    { label: 'Status', value: 'status' },
    { label: 'Reason', value: 'reason' },
    { label: 'Completed At', value: 'completed_at' },
  ]);
  return csvResponse(c, `followups-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/whatsapp', async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['1=1'];
  const binds = [];
  if (q.employeeId) {
    conds.push('w.employee_id = ?');
    binds.push(Number(q.employeeId));
  }
  if (q.status) {
    conds.push('w.status = ?');
    binds.push(q.status);
  }
  const dr = dateRangeFilter(q);
  conds.push(...dr.conds.map((x) => 'w.' + x));
  binds.push(...dr.binds);

  const rows = await db
    .prepare(
      `SELECT w.*, c.name AS customer_name, e.name AS employee_name FROM whatsapp_interactions w
       LEFT JOIN customers c ON c.id = w.customer_id LEFT JOIN employees e ON e.id = w.employee_id
       WHERE ${conds.join(' AND ')} ORDER BY w.created_at DESC LIMIT 5000`
    )
    .bind(...binds)
    .all();
  const csv = toCsv(rows.results, [
    { label: 'Customer ID', value: 'customer_id' },
    { label: 'Customer', value: 'customer_name' },
    { label: 'Employee', value: 'employee_name' },
    { label: 'Phone', value: 'phone' },
    { label: 'Status', value: 'status' },
    { label: 'Message', value: 'message' },
    { label: 'Initiated At', value: 'initiated_at' },
  ]);
  return csvResponse(c, `whatsapp-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/status', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT status, COUNT(*) AS n FROM customers WHERE archived = 0 GROUP BY status`).all();
  const csv = toCsv(rows.results, [
    { label: 'Status', value: 'status' },
    { label: 'Count', value: 'n' },
  ]);
  return csvResponse(c, `status-report-${Date.now()}.csv`, csv);
});

// --- Master upgrade additions: SLA, Seen, Call Attempts, Lead Score, Products, Sales ---

reportRoutes.get('/call-attempts', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT ca.*, c.name AS customer_name, c.phone, e.name AS employee_name, u.display_name AS attempted_by_name
       FROM call_attempts ca LEFT JOIN customers c ON c.id = ca.customer_id LEFT JOIN employees e ON e.id = ca.employee_id
       LEFT JOIN users u ON u.id = ca.attempted_by ORDER BY ca.created_at DESC LIMIT 5000`
    )
    .all();
  const csv = toCsv(rows.results, [
    { label: 'Customer ID', value: 'customer_id' },
    { label: 'Customer', value: 'customer_name' },
    { label: 'Phone', value: 'phone' },
    { label: 'Employee', value: 'employee_name' },
    { label: 'Outcome', value: 'outcome' },
    { label: 'Notes', value: 'notes' },
    { label: 'Attempted By', value: 'attempted_by_name' },
    { label: 'Created At', value: 'created_at' },
  ]);
  return csvResponse(c, `call-attempts-report-${Date.now()}.csv`, csv);
});

// SLA is always live-computed — this report is a snapshot at export time, not a stored log.
reportRoutes.get('/sla', async (c) => {
  const db = c.env.DB;
  const rules = await getSlaRules(db);
  const [seenC, contactC, interestedC] = await Promise.all([findSeenSlaCandidates(db), findContactSlaCandidates(db), findInterestedFollowupSlaCandidates(db)]);
  const now = Date.now();
  const rows = [];
  const classify = (mins, threshold) => (mins >= threshold ? 'BREACHED' : mins >= threshold * 0.7 ? 'WARNING' : 'OK');
  const withRule = (list, rule, thresholdKey) =>
    list.map((r) => {
      const mins = (now - new Date(r.anchor_at).getTime()) / 60000;
      return { customer_id: r.customer_id, employee_id: r.employee_id, rule, elapsed_minutes: Math.round(mins), level: classify(mins, rules[thresholdKey]) };
    });
  rows.push(...withRule(seenC, 'SEEN_SLA', 'seenWithinMinutes'));
  rows.push(...withRule(contactC, 'CONTACT_SLA', 'contactWithinMinutesAfterSeen'));
  rows.push(...withRule(interestedC, 'INTERESTED_FOLLOWUP_SLA', 'followupWithinMinutesAfterInterested'));
  const filtered = rows.filter((r) => r.level !== 'OK');
  const empNames = await db.prepare(`SELECT id, name FROM employees`).all();
  const empMap = Object.fromEntries(empNames.results.map((e) => [e.id, e.name]));
  const csv = toCsv(filtered, [
    { label: 'Customer ID', value: 'customer_id' },
    { label: 'Employee', value: (r) => empMap[r.employee_id] || '—' },
    { label: 'Rule', value: 'rule' },
    { label: 'Elapsed Minutes', value: 'elapsed_minutes' },
    { label: 'Level', value: 'level' },
  ]);
  return csvResponse(c, `sla-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/seen', async (c) => {
  const db = c.env.DB;
  const summary = await getSeenSummaryByEmployee(db);
  const csv = toCsv(summary, [
    { label: 'Employee', value: 'employeeName' },
    { label: 'Assigned', value: 'assigned' },
    { label: 'Seen', value: 'seen' },
    { label: 'Not Seen', value: 'notSeen' },
  ]);
  return csvResponse(c, `seen-report-${Date.now()}.csv`, csv);
});

// Lead Score is always live-computed (never stored) — capped to active, non-closed customers to bound the export.
reportRoutes.get('/lead-scores', async (c) => {
  const db = c.env.DB;
  const customers = await db.prepare(`SELECT id, name, assigned_employee_id FROM customers WHERE archived = 0 AND status != 'CLOSED' ORDER BY updated_at DESC LIMIT 1000`).all();
  const weights = await getLeadScoreWeights(db);
  const empNames = await db.prepare(`SELECT id, name FROM employees`).all();
  const empMap = Object.fromEntries(empNames.results.map((e) => [e.id, e.name]));
  const rows = [];
  for (const cust of customers.results) {
    const { score, reasons } = await computeLeadScore(db, cust.id, { weights });
    rows.push({ id: cust.id, name: cust.name, employee: empMap[cust.assigned_employee_id] || '—', score, reasons: reasons.map((r) => r.label).join('; ') });
  }
  rows.sort((a, b) => b.score - a.score);
  const csv = toCsv(rows, [
    { label: 'Customer ID', value: 'id' },
    { label: 'Name', value: 'name' },
    { label: 'Employee', value: 'employee' },
    { label: 'Lead Score', value: 'score' },
    { label: 'Reasons', value: 'reasons' },
  ]);
  return csvResponse(c, `lead-score-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/products', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT product, COUNT(*) AS n FROM customer_products GROUP BY product ORDER BY n DESC`).all();
  const csv = toCsv(rows.results, [
    { label: 'Product', value: 'product' },
    { label: 'Customers Interested', value: 'n' },
  ]);
  return csvResponse(c, `products-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/sales', async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const conds = ['1=1'];
  const binds = [];
  if (q.employeeId) { conds.push('p.attributed_employee_id = ?'); binds.push(Number(q.employeeId)); }
  if (q.branchId) { conds.push('p.branch_id = ?'); binds.push(Number(q.branchId)); }
  if (q.status) { conds.push('p.status = ?'); binds.push(q.status); }
  if (q.dateFrom) { conds.push('p.purchase_at >= ?'); binds.push(q.dateFrom); }
  if (q.dateTo) { conds.push('p.purchase_at <= ?'); binds.push(q.dateTo); }
  const rows = await db
    .prepare(
      `SELECT p.*, c.name AS customer_name, br.name AS branch_name, e.name AS employee_name FROM purchase_transactions p
       LEFT JOIN customers c ON c.id = p.customer_id JOIN branches br ON br.id = p.branch_id LEFT JOIN employees e ON e.id = p.attributed_employee_id
       WHERE ${conds.join(' AND ')} ORDER BY p.purchase_at DESC LIMIT 5000`
    )
    .bind(...binds)
    .all();
  const csv = toCsv(rows.results, [
    { label: 'Purchase ID', value: 'id' },
    { label: 'Customer ID', value: 'customer_id' },
    { label: 'Customer', value: 'customer_name' },
    { label: 'Employee', value: 'employee_name' },
    { label: 'Branch', value: 'branch_name' },
    { label: 'Purchase At', value: 'purchase_at' },
    { label: 'Invoice #', value: 'invoice_number' },
    { label: 'Order ID', value: 'order_id' },
    { label: 'Subtotal', value: 'subtotal' },
    { label: 'Discount', value: 'discount_total' },
    { label: 'Tax', value: 'tax_total' },
    { label: 'Total', value: 'total_amount' },
    { label: 'Refunded', value: 'refunded_amount' },
    { label: 'Net', value: (r) => Math.round((r.total_amount - r.refunded_amount) * 100) / 100 },
    { label: 'Payment Method', value: 'payment_method' },
    { label: 'Status', value: 'status' },
    { label: 'Source', value: 'source' },
  ]);
  return csvResponse(c, `sales-report-${Date.now()}.csv`, csv);
});

// Dedicated "Call Team → Sales Attribution" report (spec section 45).
reportRoutes.get('/sales-attribution', async (c) => {
  const db = c.env.DB;
  const employees = await db.prepare(`SELECT id, name FROM employees WHERE active = 1`).all();
  const rows = [];
  for (const emp of employees.results) {
    const [assigned, seen, contacted, interested, branchVisits, deals, revenue, lifetimeAgg] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND archived = 0`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM customer_seen WHERE employee_id = ?`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM call_attempts WHERE employee_id = ?`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE assigned_employee_id = ? AND status = 'INTERESTED'`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM customer_branch_visits WHERE employee_id = ?`).bind(emp.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM purchase_transactions WHERE attributed_employee_id = ? AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`).bind(emp.id).first(),
      db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS gross, COALESCE(SUM(refunded_amount),0) AS refunds FROM purchase_transactions WHERE attributed_employee_id = ? AND status != 'CANCELLED'`).bind(emp.id).first(),
    ]);
    const gross = revenue.gross || 0;
    const refunds = revenue.refunds || 0;
    const net = Math.round((gross - refunds) * 100) / 100;
    rows.push({
      employee: emp.name,
      assigned: assigned.n,
      seen: seen.n,
      contacted: contacted.n,
      interested: interested.n,
      branchVisits: branchVisits.n,
      deals: deals.n,
      gross: Math.round(gross * 100) / 100,
      refunds: Math.round(refunds * 100) / 100,
      net,
      conversion: assigned.n > 0 ? Math.round((deals.n / assigned.n) * 1000) / 10 : 0,
      aov: deals.n > 0 ? Math.round((net / deals.n) * 100) / 100 : 0,
    });
  }
  const csv = toCsv(rows, [
    { label: 'Employee', value: 'employee' },
    { label: 'Assigned', value: 'assigned' },
    { label: 'Seen', value: 'seen' },
    { label: 'Contacted', value: 'contacted' },
    { label: 'Interested', value: 'interested' },
    { label: 'Branch Visits', value: 'branchVisits' },
    { label: 'Deals', value: 'deals' },
    { label: 'Gross Revenue', value: 'gross' },
    { label: 'Refunds', value: 'refunds' },
    { label: 'Net Revenue', value: 'net' },
    { label: 'Conversion % (Assigned→Deal)', value: 'conversion' },
    { label: 'Avg Order Value', value: 'aov' },
  ]);
  return csvResponse(c, `call-team-sales-attribution-${Date.now()}.csv`, csv);
});
