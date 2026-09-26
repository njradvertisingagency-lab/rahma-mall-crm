import { Hono } from 'hono';
import { requireAuth, requireSalesLead } from '../lib/auth.js';
import { jsonError, backgroundWrite } from '../lib/db.js';
import { computeFunnel } from '../lib/funnel.js';
import { sessGet, sessPut } from '../lib/sessionStore.js';

export const analyticsRoutes = new Hono();
analyticsRoutes.use('*', requireAuth);

// Same cache + stale-fallback pattern as auth.js's /employees-public, reusing
// the SessionStore Durable Object as a generic KV cache. The dashboard is the
// single heaviest read in the app AND the first thing anyone looks at, so a
// short-lived cache (numbers are "fresh enough" within 30s for a KPI widget)
// cuts D1 pressure dramatically, and a "last known good" fallback means a D1
// outage shows slightly-stale numbers instead of a blank error screen.
// Scoped per role/employee since a team_leader and an employee see different
// numbers.
const DASHBOARD_CACHE_TTL_MS = 30 * 1000;
function dashboardCacheKey(user) {
  return `cache:dashboard:${user.role}:${user.employeeId ?? 'all'}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function rangeToDates(range, from, to) {
  const now = new Date();
  if (range === 'custom' && from && to) return { from, to };
  const end = now.toISOString();
  let start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else if (range === 'yesterday') {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
  } else if (range === '7d') start.setDate(start.getDate() - 7);
  else if (range === '30d') start.setDate(start.getDate() - 30);
  else start.setDate(start.getDate() - 7);
  return { from: start.toISOString(), to: end };
}

analyticsRoutes.get('/dashboard', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const scope = user.role === 'employee' ? 'AND assigned_employee_id = ?' : '';
  const binds = user.role === 'employee' ? [user.employeeId] : [];

  const cacheKey = dashboardCacheKey(user);
  const cached = await sessGet(c.env, cacheKey).catch(() => null);
  if (cached && Date.now() - cached.cachedAt < DASHBOARD_CACHE_TTL_MS) {
    return c.json(cached.payload);
  }

  // This is the main dashboard KPI widget — a dozen+ D1 queries fired on
  // every visit to the control room, so it is the single heaviest, most
  // frequently-hit read in the whole app. When D1's quota is exhausted, this
  // was throwing a raw 500 mid-way through and taking down the whole
  // dashboard with an opaque "فشل الطلب" toast — wrapped the same way as
  // auth.js's login/employees-public handlers so the failure is at least
  // honest, plus a short cache + stale fallback (see above) so most visits
  // never even reach D1, and an outage shows the last known numbers instead
  // of an error screen.
  try {
    const statusRows = await db.prepare(`SELECT status, COUNT(*) AS n FROM customers WHERE archived = 0 ${scope} GROUP BY status`).bind(...binds).all();
    const byStatus = Object.fromEntries(statusRows.results.map((r) => [r.status, r.n]));

    const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 ${scope}`).bind(...binds).first();
    const unassignedRow = user.role === 'team_leader' ? await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NULL`).first() : { n: 0 };
    const assignedRow = await db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND assigned_employee_id IS NOT NULL ${scope}`).bind(...binds).first();

    const today = todayStartIso();
    const todayBinds = user.role === 'employee' ? [today, user.employeeId] : [today];
    const todayScope = user.role === 'employee' ? 'AND assigned_employee_id = ?' : '';
    const [todayCustomers, todayClosed] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND created_at >= ? ${todayScope}`).bind(...todayBinds).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE archived = 0 AND closed_at >= ? ${todayScope}`).bind(...todayBinds).first(),
    ]);

    const followupScope = user.role === 'employee' ? 'AND employee_id = ?' : '';
    const followupBinds = user.role === 'employee' ? [user.employeeId] : [];
    const [todayFollowups, overdueFollowups] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE date(scheduled_for) = date('now') AND status IN ('UPCOMING','OVERDUE') ${followupScope}`).bind(...followupBinds).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE (status = 'OVERDUE' OR (status = 'UPCOMING' AND scheduled_for < datetime('now'))) ${followupScope}`).bind(...followupBinds).first(),
    ]);

    const total = totalRow.n || 0;
    const closed = byStatus.CLOSED || 0;
    const completionRate = total > 0 ? closed / total : 0;

    const waScope = user.role === 'employee' ? 'AND employee_id = ?' : '';
    const waBinds = user.role === 'employee' ? [user.employeeId] : [];
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [waToday, waWeek, waMonth] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_interactions WHERE created_at >= ? ${waScope}`).bind(today, ...waBinds).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_interactions WHERE created_at >= ? ${waScope}`).bind(weekAgo, ...waBinds).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_interactions WHERE created_at >= ? ${waScope}`).bind(monthAgo, ...waBinds).first(),
    ]);

    const payload = {
      kpis: {
        whatsappToday: waToday.n,
        whatsappWeek: waWeek.n,
        whatsappMonth: waMonth.n,
        total,
        unassigned: unassignedRow.n,
        assigned: assignedRow.n,
        new: byStatus.NEW || 0,
        calling: byStatus.CALLING || 0,
        noAnswer: byStatus.NO_ANSWER || 0,
        busy: byStatus.BUSY || 0,
        followUp: byStatus.FOLLOW_UP || 0,
        interested: byStatus.INTERESTED || 0,
        notInterested: byStatus.NOT_INTERESTED || 0,
        closed,
        overdue: overdueFollowups.n,
        todayCustomers: todayCustomers.n,
        todayClosed: todayClosed.n,
        todayFollowups: todayFollowups.n,
        todayOverdue: overdueFollowups.n,
        completionRate,
      },
    };

    backgroundWrite(c, () => sessPut(c.env, cacheKey, { payload, cachedAt: Date.now() }), 'analytics/dashboard: could not update cache (non-fatal)');
    return c.json(payload);
  } catch (err) {
    console.error('analytics/dashboard: D1 unavailable, falling back to last known numbers', err);
    if (cached) return c.json({ ...cached.payload, stale: true });
    return jsonError(c, 503, 'تعذر تحميل لوحة التحكم مؤقتًا بسبب ضغط على قاعدة البيانات — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
  }
});

analyticsRoutes.get('/charts', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const q = c.req.query();

  // Read-only insight data (like /dashboard) — safe to cache and to serve
  // stale on a D1 outage, unlike the live customer/followup queues.
  const cacheKey = `cache:analytics_charts:${user.role}:${user.employeeId ?? 'all'}:${c.req.url.split('?')[1] || ''}`;
  const cached = await sessGet(c.env, cacheKey).catch(() => null);
  if (cached && Date.now() - cached.cachedAt < DASHBOARD_CACHE_TTL_MS) {
    return c.json(cached.payload);
  }

  const { from, to } = rangeToDates(q.range || '7d', q.from, q.to);
  const scope = user.role === 'employee' ? 'AND c.assigned_employee_id = ?' : '';
  const scopeBinds = user.role === 'employee' ? [user.employeeId] : [];

  try {
  const [byEmployee, byStatus, daily, bySource, byCampaign] = await Promise.all([
    db
      .prepare(
        `SELECT e.name AS label, COUNT(*) AS value FROM customers c JOIN employees e ON e.id = c.assigned_employee_id
         WHERE c.archived = 0 AND c.created_at BETWEEN ? AND ? ${scope} GROUP BY e.name ORDER BY value DESC`
      )
      .bind(from, to, ...scopeBinds)
      .all(),
    db
      .prepare(`SELECT status AS label, COUNT(*) AS value FROM customers c WHERE archived = 0 ${scope} GROUP BY status`)
      .bind(...scopeBinds)
      .all(),
    db
      .prepare(
        `SELECT date(created_at) AS label, COUNT(*) AS value FROM customers c WHERE archived = 0 AND created_at BETWEEN ? AND ? ${scope} GROUP BY date(created_at) ORDER BY label`
      )
      .bind(from, to, ...scopeBinds)
      .all(),
    db
      .prepare(`SELECT COALESCE(source,'Unknown') AS label, COUNT(*) AS value FROM customers c WHERE archived = 0 ${scope} GROUP BY label ORDER BY value DESC LIMIT 10`)
      .bind(...scopeBinds)
      .all(),
    db
      .prepare(`SELECT COALESCE(campaign,'Unknown') AS label, COUNT(*) AS value FROM customers c WHERE archived = 0 ${scope} GROUP BY label ORDER BY value DESC LIMIT 10`)
      .bind(...scopeBinds)
      .all(),
  ]);

  const payload = {
    range: { from, to },
    customersByEmployee: byEmployee.results,
    statusDistribution: byStatus.results,
    dailyActivity: daily.results,
    bySource: bySource.results,
    byCampaign: byCampaign.results,
  };
  backgroundWrite(c, () => sessPut(c.env, cacheKey, { payload, cachedAt: Date.now() }), 'analytics/charts: could not update cache (non-fatal)');
  return c.json(payload);
  } catch (err) {
    console.error('analytics/charts: D1 unavailable, falling back to last known numbers', err);
    if (cached) return c.json({ ...cached.payload, stale: true });
    return jsonError(c, 503, 'تعذر تحميل الرسوم البيانية مؤقتًا بسبب ضغط على قاعدة البيانات — برجاء المحاولة خلال دقائق', 'DB_TEMPORARILY_UNAVAILABLE');
  }
});

// ---------------------------------------------------------------------------
// SALES ANALYTICS (Team-Leader-only, like /charts' cross-employee data)
// ---------------------------------------------------------------------------
analyticsRoutes.get('/sales', requireSalesLead, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const { from, to } = rangeToDates(q.range || 'today', q.from, q.to);
  const [sales, funnel] = await Promise.all([
    (async () => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS deals, COALESCE(SUM(total_amount),0) AS gross, COALESCE(SUM(refunded_amount),0) AS refunds
           FROM purchase_transactions WHERE purchase_at BETWEEN ? AND ? AND status != 'CANCELLED'`
        )
        .bind(from, to)
        .first();
      const visits = await db.prepare(`SELECT COUNT(*) AS n FROM customer_branch_visits WHERE visit_at BETWEEN ? AND ?`).bind(from, to).first();
      const net = round2(row.gross - row.refunds);
      return {
        deals: row.deals,
        branchVisits: visits.n,
        grossRevenue: round2(row.gross),
        refunds: round2(row.refunds),
        netRevenue: net,
        averageOrderValue: row.deals > 0 ? round2(net / row.deals) : 0,
        conversionRate: visits.n > 0 ? round2((row.deals / visits.n) * 100) : 0,
      };
    })(),
    computeFunnel(db, { from, to }),
  ]);
  return c.json({ range: { from, to }, sales, funnel });
});

analyticsRoutes.get('/sales/employees', requireSalesLead, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const { from, to } = rangeToDates(q.range || '30d', q.from, q.to);
  const rows = await db
    .prepare(
      `SELECT e.id, e.name, e.name_ar AS nameAr,
         COUNT(DISTINCT c.id) AS assigned,
         COUNT(DISTINCT CASE WHEN cs.customer_id IS NOT NULL THEN c.id END) AS seen,
         COUNT(DISTINCT ca.customer_id) AS contacted,
         COUNT(DISTINCT CASE WHEN c.status = 'INTERESTED' THEN c.id END) AS interested,
         COUNT(DISTINCT bv.customer_id) AS branchVisits,
         COUNT(DISTINCT CASE WHEN p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED') THEN p.id END) AS deals,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.total_amount ELSE 0 END), 0) AS grossRevenue,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.refunded_amount ELSE 0 END), 0) AS refunds
       FROM employees e
       LEFT JOIN customers c ON c.assigned_employee_id = e.id AND c.archived = 0
       LEFT JOIN customer_seen cs ON cs.customer_id = c.id AND cs.employee_id = e.id AND cs.seen_at >= c.assigned_at
       LEFT JOIN call_attempts ca ON ca.customer_id = c.id
       LEFT JOIN customer_branch_visits bv ON bv.customer_id = c.id
       LEFT JOIN purchase_transactions p ON p.attributed_employee_id = e.id AND p.purchase_at BETWEEN ? AND ?
       WHERE e.active = 1
       GROUP BY e.id
       ORDER BY e.name COLLATE NOCASE`
    )
    .bind(from, to)
    .all();
  const results = rows.results.map((r) => {
    const net = round2(r.grossRevenue - r.refunds);
    return { ...r, netRevenue: net, conversionRate: r.assigned > 0 ? round2((r.deals / r.assigned) * 100) : 0, averageOrderValue: r.deals > 0 ? round2(net / r.deals) : 0 };
  });
  return c.json({ range: { from, to }, employees: results });
});

analyticsRoutes.get('/sales/branches', requireSalesLead, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const { from, to } = rangeToDates(q.range || '30d', q.from, q.to);
  const rows = await db
    .prepare(
      `SELECT br.id, br.name,
         COUNT(DISTINCT bv.id) AS visits,
         COUNT(DISTINCT CASE WHEN p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED') THEN p.id END) AS deals,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.total_amount ELSE 0 END), 0) AS grossRevenue,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.refunded_amount ELSE 0 END), 0) AS refunds
       FROM branches br
       LEFT JOIN customer_branch_visits bv ON bv.branch_id = br.id AND bv.visit_at BETWEEN ? AND ?
       LEFT JOIN purchase_transactions p ON p.branch_id = br.id AND p.purchase_at BETWEEN ? AND ?
       WHERE br.active = 1
       GROUP BY br.id
       ORDER BY br.name COLLATE NOCASE`
    )
    .bind(from, to, from, to)
    .all();
  const results = rows.results.map((r) => ({ ...r, netRevenue: round2(r.grossRevenue - r.refunds) }));
  return c.json({ range: { from, to }, branches: results });
});

analyticsRoutes.get('/sales/campaigns', requireSalesLead, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const { from, to } = rangeToDates(q.range || '30d', q.from, q.to);
  const rows = await db
    .prepare(
      `SELECT COALESCE(c.campaign, 'Unknown') AS campaign,
         COUNT(DISTINCT c.id) AS leads,
         COUNT(DISTINCT ca.customer_id) AS contacted,
         COUNT(DISTINCT CASE WHEN c.status = 'INTERESTED' THEN c.id END) AS interested,
         COUNT(DISTINCT bv.customer_id) AS branchVisits,
         COUNT(DISTINCT CASE WHEN p.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED') THEN p.id END) AS deals,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.total_amount ELSE 0 END), 0) AS grossRevenue,
         COALESCE(SUM(CASE WHEN p.status != 'CANCELLED' THEN p.refunded_amount ELSE 0 END), 0) AS refunds
       FROM customers c
       LEFT JOIN call_attempts ca ON ca.customer_id = c.id
       LEFT JOIN customer_branch_visits bv ON bv.customer_id = c.id
       LEFT JOIN purchase_transactions p ON p.customer_id = c.id AND p.purchase_at BETWEEN ? AND ?
       WHERE c.archived = 0 AND c.created_at BETWEEN ? AND ?
       GROUP BY campaign
       ORDER BY grossRevenue DESC`
    )
    .bind(from, to, from, to)
    .all();
  const results = rows.results.map((r) => ({ ...r, netRevenue: round2(r.grossRevenue - r.refunds) }));
  return c.json({ range: { from, to }, campaigns: results });
});

analyticsRoutes.get('/sales/products', requireSalesLead, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const { from, to } = rangeToDates(q.range || '30d', q.from, q.to);
  const rows = await db
    .prepare(
      `SELECT pi.product_name AS product,
         COUNT(DISTINCT pi.purchase_id) AS orders,
         SUM(pi.quantity) AS units,
         SUM(pi.subtotal) AS grossRevenue
       FROM purchase_items pi
       JOIN purchase_transactions p ON p.id = pi.purchase_id
       WHERE p.status != 'CANCELLED' AND p.purchase_at BETWEEN ? AND ?
       GROUP BY pi.product_name
       ORDER BY grossRevenue DESC`
    )
    .bind(from, to)
    .all();
  return c.json({ range: { from, to }, products: rows.results.map((r) => ({ ...r, grossRevenue: round2(r.grossRevenue) })) });
});
