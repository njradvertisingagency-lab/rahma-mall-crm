import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAppHeader } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { customerRoutes } from './routes/customers.js';
import { distributionRoutes, reassignmentRoutes } from './routes/distributions.js';
import { followupRoutes, sweepOverdueFollowups } from './routes/followups.js';
import { notificationRoutes } from './routes/notifications.js';
import { activityRoutes } from './routes/activity.js';
import { analyticsRoutes } from './routes/analytics.js';
import { reportRoutes } from './routes/reports.js';
import { aiRoutes } from './routes/ai.js';
import { employeeRoutes } from './routes/employees.js';
import { settingsRoutes } from './routes/settings.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { presenceRoutes } from './routes/presence.js';
import { salesRoutes } from './routes/sales.js';
import { commandCenterRoutes } from './routes/command-center.js';
import { savedFilterRoutes } from './routes/saved-filters.js';
import { complaintRoutes } from './routes/complaints.js';
import { favoriteRoutes } from './routes/favorites.js';
import { chatRoutes } from './routes/chat.js';
import { opsReportRoutes } from './routes/opsreports.js';
import { attendanceRoutes } from './routes/attendance.js';
import { handleWebSocketUpgrade } from './routes/ws.js';
import { sweepPresence } from './lib/presence.js';
import { sweepSlaBreaches, sweepCustomerWaiting } from './lib/sla.js';
import { recordDailySnapshots } from './lib/performance.js';
import { sweepDnd } from './lib/dnd.js';
import { sweepLateAttendance, sweepOffHoursAvailability } from './lib/workhours.js';
import { sweepOpsReports } from './lib/opsreports.js';
import { sweepAutoReclaim } from './lib/reclaim.js';

export { TeamRoom } from './durable-objects/team-room.js';
export { AttendanceStore } from './durable-objects/attendance-store.js';
export { SessionStore } from './durable-objects/session-store.js';

const app = new Hono();

// Security headers on every response.
app.use('*', async (c, next) => {
  await next();
  // A WebSocket upgrade response (status 101) has immutable headers — skip it.
  if (c.res && c.res.status !== 101) {
    try {
      c.res.headers.set('X-Content-Type-Options', 'nosniff');
      c.res.headers.set('X-Frame-Options', 'DENY');
      c.res.headers.set('Referrer-Policy', 'same-origin');
    } catch {
      // Some responses (e.g. streamed) may still refuse header mutation — non-fatal.
    }
  }
});

// CORS support for the split-origin production deployment (frontend on
// Cloudflare Pages, API on this Worker's own workers.dev domain). Local dev
// serves both from the same origin via the [assets] binding, so this only
// matters for cross-origin browsers — credentials must be explicitly
// allowed and the origin echoed back (never '*') for cookies to work.
const ALLOWED_ORIGINS = new Set([
  'https://rahma-mall-crm.pages.dev',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);
app.use(
  '/api/*',
  cors({
    origin: (origin) => (origin && ALLOWED_ORIGINS.has(origin) ? origin : ''),
    credentials: true,
    allowHeaders: ['content-type', 'x-rahma-client'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  })
);

app.get('/api/health', (c) => c.json({ ok: true, service: 'rahma-mall-crm', time: new Date().toISOString() }));

const api = new Hono();
api.use('*', requireAppHeader);
api.route('/auth', authRoutes);
api.route('/customers', customerRoutes);
api.route('/distributions', distributionRoutes);
api.route('/reassignments', reassignmentRoutes);
api.route('/followups', followupRoutes);
api.route('/notifications', notificationRoutes);
api.route('/activity', activityRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/reports', reportRoutes);
api.route('/ai', aiRoutes);
api.route('/employees', employeeRoutes);
api.route('/settings', settingsRoutes);
api.route('/whatsapp', whatsappRoutes);
api.route('/presence', presenceRoutes);
api.route('/sales', salesRoutes);
api.route('/command-center', commandCenterRoutes);
api.route('/saved-filters', savedFilterRoutes);
api.route('/complaints', complaintRoutes);
api.route('/favorites', favoriteRoutes);
api.route('/chat', chatRoutes);
api.route('/ops-reports', opsReportRoutes);
api.route('/attendance', attendanceRoutes);
app.route('/api', api);

// Real-time WebSocket upgrade — authenticated in routes/ws.js before ever
// reaching the Durable Object.
app.get('/ws', (c) => handleWebSocketUpgrade(c.req.raw, c.env));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path === '/ws') {
    return c.json({ error: { message: 'غير موجود' } }, 404);
  }
  // Fall through to static assets (the SPA's index.html handles client routes).
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404);
});

// A database outage is the one failure this app hits in normal operation:
// D1's free tier caps daily row reads, and once that cap is reached EVERY
// query throws until it resets at midnight UTC. Individual hot endpoints
// cache their last good payload and degrade on their own, but there are far
// too many queries app-wide to guard each one by hand — and an unguarded
// throw surfaces as a raw 500, which reads to the team as "the whole system
// is broken" rather than "the database is busy, try again shortly".
// Recognising the outage here, once, gives every remaining endpoint an
// honest answer without touching hundreds of call sites.
const DB_OUTAGE_SIGNATURES = [
  'exceeded',
  'row read limit',
  'd1_error',
  'daily limit',
  'quota',
  'network connection lost',
  'storage operation exceeded timeout',
  'too many api requests',
];

function isDatabaseOutage(err) {
  const text = [err?.message, err?.cause?.message, err?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  return DB_OUTAGE_SIGNATURES.some((sig) => text.includes(sig));
}

app.onError((err, c) => {
  const outage = isDatabaseOutage(err);
  console.error(
    outage ? 'DB outage escaped a route' : 'unhandled error',
    c.req.method,
    c.req.path,
    err
  );

  const isApi = c.req.path.startsWith('/api/') || c.req.path === '/ws';
  if (!isApi) {
    return c.text('Service temporarily unavailable', outage ? 503 : 500);
  }

  if (outage) {
    return c.json(
      {
        error: {
          message:
            'تعذر تحميل البيانات مؤقتًا بسبب ضغط على قاعدة البيانات — برجاء المحاولة خلال دقائق',
          code: 'DB_TEMPORARILY_UNAVAILABLE',
        },
      },
      503
    );
  }

  return c.json(
    {
      error: {
        message: 'حدث خطأ غير متوقع — برجاء المحاولة مرة أخرى',
        code: 'INTERNAL_ERROR',
      },
    },
    500
  );
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  // Cron trigger — TWO cadences (see wrangler.toml for why): "* * * * *"
  // every minute for the one thing worth checking that often (presence),
  // and "*/5 * * * *" every 5 minutes for everything else. Each sweep stays
  // isolated so one failing never blocks the others.
  async scheduled(event, env, ctx) {
    if (event.cron === '* * * * *') {
      ctx.waitUntil(sweepPresence(env.DB, env).catch((e) => console.error('sweepPresence failed', e)));
      return;
    }
    // '*/5 * * * *' (or any other/unrecognized cron — safe default so a
    // future trigger never silently runs nothing).
    ctx.waitUntil(sweepOverdueFollowups(env));
    ctx.waitUntil(sweepSlaBreaches(env.DB, env).catch((e) => console.error('sweepSlaBreaches failed', e)));
    ctx.waitUntil(sweepCustomerWaiting(env.DB, env).catch((e) => console.error('sweepCustomerWaiting failed', e)));
    ctx.waitUntil(recordDailySnapshots(env.DB).catch((e) => console.error('recordDailySnapshots failed', e)));
    ctx.waitUntil(sweepDnd(env.DB, env).catch((e) => console.error('sweepDnd failed', e)));
    ctx.waitUntil(sweepLateAttendance(env.DB, env).catch((e) => console.error('sweepLateAttendance failed', e)));
    ctx.waitUntil(sweepOffHoursAvailability(env.DB, env).catch((e) => console.error('sweepOffHoursAvailability failed', e)));
    ctx.waitUntil(sweepOpsReports(env.DB, env).catch((e) => console.error('sweepOpsReports failed', e)));
    ctx.waitUntil(sweepAutoReclaim(env.DB, env).catch((e) => console.error('sweepAutoReclaim failed', e)));
  },
};
