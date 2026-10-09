import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError, backgroundWrite } from '../lib/db.js';
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
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000; // ٥ دقايق — الزرار 🔄 بيتخطاه (?fresh=1)
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
  const wantFresh = c.req.query('fresh') === '1';
  if (!wantFresh && cached && Date.now() - cached.cachedAt < DASHBOARD_CACHE_TTL_MS) {
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
    const unopenedRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM customers c WHERE c.archived = 0 AND c.assigned_employee_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM customer_seen cs WHERE cs.customer_id = c.id AND cs.employee_id = c.assigned_employee_id AND cs.seen_at >= c.assigned_at)
       ${scope}`
    ).bind(...binds).first();

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
        unopened: unopenedRow.n,
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
