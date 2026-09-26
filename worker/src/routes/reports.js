import { Hono } from 'hono';
import { requireAuth, requireSalesLead } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { computeAllEmployeeStats } from '../lib/performance.js';
import { getSeenSummaryByEmployee } from '../lib/seen.js';
import { getSlaRules, findSeenSlaCandidates, findContactSlaCandidates, findInterestedFollowupSlaCandidates } from '../lib/sla.js';
import { computeLeadScore, getLeadScoreWeights } from '../lib/leadscore.js';
import { getCustomerLifetimeValue } from '../lib/sales.js';

export const reportRoutes = new Hono();
reportRoutes.use('*', requireAuth, requireSalesLead);

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
    { label: 'كود العميل', value: 'id' },
    { label: 'الهاتف', value: 'phone' },
    { label: 'الاسم', value: 'name' },
    { label: 'الموظف المسؤول', value: 'employee_name' },
    { label: 'الحالة', value: 'status' },
    { label: 'الأولوية', value: 'priority' },
    { label: 'المصدر', value: 'source' },
    { label: 'الحملة', value: 'campaign' },
    { label: 'تاريخ الإنشاء', value: 'created_at' },
    { label: 'تاريخ التعيين', value: 'assigned_at' },
    { label: 'آخر تحديث', value: 'updated_at' },
    { label: 'المتابعة القادمة', value: 'next_follow_up_at' },
    { label: 'تاريخ الإغلاق', value: 'closed_at' },
    { label: 'سبب الإغلاق', value: 'closed_reason' },
  ]);
  return csvResponse(c, `customers-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/employees', async (c) => {
  const db = c.env.DB;
  const { stats } = await computeAllEmployeeStats(db);
  const csv = toCsv(stats, [
    { label: 'الموظف', value: (r) => r.employee.name },
    { label: 'موزّع', value: 'assigned' },
    { label: 'مغلق', value: 'closed' },
    { label: 'مهتم', value: 'interested' },
    { label: 'إجمالي المتابعات', value: 'followupsTotal' },
    { label: 'المتابعات المكتملة', value: 'followupsCompleted' },
    { label: 'المتابعات المتأخرة', value: 'followupsOverdue' },
    { label: 'نسبة الإنجاز', value: (r) => (r.completionRate * 100).toFixed(1) + '%' },
    { label: 'نقاط الأداء', value: 'performanceScore' },
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
    { label: 'التوقيت', value: 'created_at' },
    { label: 'المستخدم', value: 'actor_name' },
    { label: 'الدور', value: 'actor_role' },
    { label: 'الإجراء', value: 'action' },
    { label: 'نوع الكيان', value: 'entity_type' },
    { label: 'كود الكيان', value: 'entity_id' },
    { label: 'بيانات إضافية', value: 'metadata' },
  ]);
  return csvResponse(c, `activity-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/followups', async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(`SELECT f.*, e.name AS employee_name, c.name AS customer_name, c.phone FROM followups f LEFT JOIN employees e ON e.id = f.employee_id LEFT JOIN customers c ON c.id = f.customer_id ORDER BY f.scheduled_for DESC LIMIT 5000`)
    .all();
  const csv = toCsv(rows.results, [
    { label: 'كود العميل', value: 'customer_id' },
    { label: 'العميل', value: 'customer_name' },
    { label: 'الهاتف', value: 'phone' },
    { label: 'الموظف', value: 'employee_name' },
    { label: 'موعد المتابعة', value: 'scheduled_for' },
    { label: 'الحالة', value: 'status' },
    { label: 'السبب', value: 'reason' },
    { label: 'تاريخ الإنجاز', value: 'completed_at' },
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
    { label: 'كود العميل', value: 'customer_id' },
    { label: 'العميل', value: 'customer_name' },
    { label: 'الموظف', value: 'employee_name' },
    { label: 'الهاتف', value: 'phone' },
    { label: 'الحالة', value: 'status' },
    { label: 'الرسالة', value: 'message' },
    { label: 'تاريخ البدء', value: 'initiated_at' },
  ]);
  return csvResponse(c, `whatsapp-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/status', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT status, COUNT(*) AS n FROM customers WHERE archived = 0 GROUP BY status`).all();
  const csv = toCsv(rows.results, [
    { label: 'الحالة', value: 'status' },
    { label: 'العدد', value: 'n' },
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
    { label: 'كود العميل', value: 'customer_id' },
    { label: 'العميل', value: 'customer_name' },
    { label: 'الهاتف', value: 'phone' },
    { label: 'الموظف', value: 'employee_name' },
    { label: 'النتيجة', value: 'outcome' },
    { label: 'ملاحظات', value: 'notes' },
    { label: 'بواسطة', value: 'attempted_by_name' },
    { label: 'تاريخ الإنشاء', value: 'created_at' },
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
    { label: 'كود العميل', value: 'customer_id' },
    { label: 'الموظف', value: (r) => empMap[r.employee_id] || '—' },
    { label: 'القاعدة', value: 'rule' },
    { label: 'الدقائق المنقضية', value: 'elapsed_minutes' },
    { label: 'المستوى', value: 'level' },
  ]);
  return csvResponse(c, `sla-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/seen', async (c) => {
  const db = c.env.DB;
  const summary = await getSeenSummaryByEmployee(db);
  const csv = toCsv(summary, [
    { label: 'الموظف', value: 'employeeName' },
    { label: 'موزّع', value: 'assigned' },
    { label: 'تمت رؤيته', value: 'seen' },
    { label: 'لم تتم رؤيته', value: 'notSeen' },
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
    { label: 'كود العميل', value: 'id' },
    { label: 'الاسم', value: 'name' },
    { label: 'الموظف', value: 'employee' },
    { label: 'تقييم العميل', value: 'score' },
    { label: 'الأسباب', value: 'reasons' },
  ]);
  return csvResponse(c, `lead-score-report-${Date.now()}.csv`, csv);
});

reportRoutes.get('/products', async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT product, COUNT(*) AS n FROM customer_products GROUP BY product ORDER BY n DESC`).all();
  const csv = toCsv(rows.results, [
    { label: 'المنتج', value: 'product' },
    { label: 'عدد العملاء المهتمين', value: 'n' },
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
    { label: 'كود عملية الشراء', value: 'id' },
    { label: 'كود العميل', value: 'customer_id' },
    { label: 'العميل', value: 'customer_name' },
    { label: 'الموظف', value: 'employee_name' },
    { label: 'الفرع', value: 'branch_name' },
    { label: 'تاريخ الشراء', value: 'purchase_at' },
    { label: 'رقم الفاتورة', value: 'invoice_number' },
    { label: 'رقم الطلب', value: 'order_id' },
    { label: 'الإجمالي الفرعي', value: 'subtotal' },
    { label: 'الخصم', value: 'discount_total' },
    { label: 'الضريبة', value: 'tax_total' },
    { label: 'الإجمالي', value: 'total_amount' },
    { label: 'المسترجع', value: 'refunded_amount' },
    { label: 'الصافي', value: (r) => Math.round((r.total_amount - r.refunded_amount) * 100) / 100 },
    { label: 'طريقة الدفع', value: 'payment_method' },
    { label: 'الحالة', value: 'status' },
    { label: 'المصدر', value: 'source' },
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
    { label: 'الموظف', value: 'employee' },
    { label: 'موزّع', value: 'assigned' },
    { label: 'تمت رؤيته', value: 'seen' },
    { label: 'تم التواصل', value: 'contacted' },
    { label: 'مهتم', value: 'interested' },
    { label: 'زيارات الفرع', value: 'branchVisits' },
    { label: 'الصفقات', value: 'deals' },
    { label: 'إجمالي الإيراد', value: 'gross' },
    { label: 'المرتجعات', value: 'refunds' },
    { label: 'صافي الإيراد', value: 'net' },
    { label: 'نسبة التحويل (موزّع ← صفقة)', value: 'conversion' },
    { label: 'متوسط قيمة الطلب', value: 'aov' },
  ]);
  return csvResponse(c, `call-team-sales-attribution-${Date.now()}.csv`, csv);
});
