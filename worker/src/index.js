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
import { leaveRoutes } from './routes/leaves.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { violationRoutes } from './routes/violations.js';
import { trainingRoutes } from './routes/trainings.js';
import { documentRoutes } from './routes/documents.js';
import { benefitRoutes } from './routes/benefits.js';
import { announcementRoutes } from './routes/announcements.js';
import { rewardsRoutes } from './routes/rewards.js';
import { handleWebSocketUpgrade } from './routes/ws.js';
import { sweepPresence } from './lib/presence.js';
import { sweepSlaBreaches, sweepCustomerWaiting } from './lib/sla.js';
import { recordDailySnapshots } from './lib/performance.js';
import { sweepDnd } from './lib/dnd.js';
import { sweepLateAttendance, sweepOffHoursAvailability, getCairoNow, getCairoWeekday, isDueEvery } from './lib/workhours.js';
import { sweepOpsReports } from './lib/opsreports.js';
import { sweepAutoReclaim } from './lib/reclaim.js';
import { sweepLateNotePenalty, sweepMonthlyTopSales } from './lib/motivation.js';

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
api.route('/rewards', rewardsRoutes);
api.route('/favorites', favoriteRoutes);
api.route('/chat', chatRoutes);
api.route('/ops-reports', opsReportRoutes);
api.route('/attendance', attendanceRoutes);
api.route('/leaves', leaveRoutes);
api.route('/evaluations', evaluationRoutes);
api.route('/violations', violationRoutes);
api.route('/trainings', trainingRoutes);
api.route('/documents', documentRoutes);
api.route('/benefits', benefitRoutes);
api.route('/announcements', announcementRoutes);
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
// Matched against the error text. These stay deliberately specific: a loose
// word like "exceeded" also appears in "Maximum call stack size exceeded",
// and reporting a real bug as a database problem would send whoever is
// debugging it after entirely the wrong thing.
const DB_OUTAGE_SIGNATURES = [
  'd1_error',
  'row read limit',
  'daily row read',
  'rows read limit',
  'network connection lost',
  'storage operation exceeded timeout',
  'too many api requests',
  'd1 is temporarily unavailable',
];

function isDatabaseOutage(err) {
  const text = [err?.message, err?.cause?.message, err?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  if (DB_OUTAGE_SIGNATURES.some((sig) => text.includes(sig))) return true;
  // The quota error's exact wording has changed before, so also treat any
  // D1-attributed limit/quota complaint as an outage.
  return text.includes('d1') && (text.includes('limit') || text.includes('quota'));
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

// The shift is 10:00–18:00 Cairo, Thursday and Friday off. The sweep window
// is deliberately wider than the shift at both ends, because a few sweeps
// must fire just OUTSIDE it: the pre-shift availability restore runs before
// 10:00, and the end-of-shift ops report plus the idle-customer auto-reclaim
// both only run at or after 18:00. The margins below give each of those
// plenty of ticks to land.
//
// These bounds are intentionally hardcoded and D1-free: reading the
// configurable work_hours row on every tick would cost the very reads this
// gate exists to save. If the shift ever moves far outside 09:30–19:30,
// widen this window to match — the settings row alone will not move it.
const SWEEP_WINDOW_START_MIN = 9 * 60 + 30;
const SWEEP_WINDOW_END_MIN = 19 * 60 + 30;
const SWEEP_SKIP_WEEKDAYS = ['Thursday', 'Friday'];

function sweepsShouldRunNow() {
  try {
    if (SWEEP_SKIP_WEEKDAYS.includes(getCairoWeekday())) return false;
    const { minutesSinceMidnight } = getCairoNow();
    return minutesSinceMidnight >= SWEEP_WINDOW_START_MIN && minutesSinceMidnight <= SWEEP_WINDOW_END_MIN;
  } catch (err) {
    // If the clock lookup ever fails, run the sweeps rather than silently
    // stopping all automation — a wasted tick is cheaper than a missed alert.
    console.error('sweep window check failed, running sweeps anyway', err);
    return true;
  }
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  // Cron trigger — TWO cadences (see wrangler.toml for why): "* * * * *"
  // every minute for the one thing worth checking that often (presence),
  // and "*/5 * * * *" every 5 minutes for everything else. Each sweep stays
  // isolated so one failing never blocks the others.
  async scheduled(event, env, ctx) {
    // Every sweep below exists to watch employees while they work. Outside
    // the shift there is nobody to watch, yet the crons still fired around
    // the clock — 1,440 + 288 runs a day, every day, each one reading D1.
    // That is the bulk of the daily read quota spent on empty office hours,
    // which is why the quota kept running out mid-morning.
    //
    // Skipping the idle hours is safe because no sweep needs to fire at an
    // exact minute: each one already carries its own same-day dedup guard,
    // and the states they set (off-hours DND, availability) simply persist
    // overnight untouched, which is the correct resting state anyway.
    if (!sweepsShouldRunNow()) return;

    if (event.cron === '* * * * *') {
      // كانت كل دقيقة (١٤٤٠ تشغيلة/يوم) — أهم سبب في استهلاك حصة القراءة
      // المجانية اليومية. التواجد (presence) ما يحتاجش دقة دقيقة بدقيقة؛
      // كل ٣ دقايق كافي جدًا وبيوفر ثلثي القراءات من غير ما حد يحس بفرق.
      if (isDueEvery(3, 1)) {
        ctx.waitUntil(sweepPresence(env.DB, env).catch((e) => console.error('sweepPresence failed', e)));
      }
      return;
    }
    // '*/5 * * * *' (or any other/unrecognized cron — safe default so a
    // future trigger never silently runs nothing).
    ctx.waitUntil(sweepOverdueFollowups(env).catch((e) => console.error('sweepOverdueFollowups failed', e)));
    ctx.waitUntil(sweepSlaBreaches(env.DB, env).catch((e) => console.error('sweepSlaBreaches failed', e)));
    ctx.waitUntil(sweepCustomerWaiting(env.DB, env).catch((e) => console.error('sweepCustomerWaiting failed', e)));
    // كانت بتشتغل كل ٥ دقايق وبتعمل ٤ استعلامات لكل موظف نشط في كل تشغيلة —
    // أكبر مستهلك لحصة القراءة اليومية بالكامل. البيانات دي لرسم بياني
    // تاريخي (trend chart) مش شاشة لايف، فمرة كل ساعة كافية تمامًا وبتوفر
    // ٩٢٪ من قراءات هذا الجزء تحديدًا.
    if (isDueEvery(60, 5)) {
      ctx.waitUntil(recordDailySnapshots(env.DB).catch((e) => console.error('recordDailySnapshots failed', e)));
    }
    ctx.waitUntil(sweepDnd(env.DB, env).catch((e) => console.error('sweepDnd failed', e)));
    ctx.waitUntil(sweepLateAttendance(env.DB, env).catch((e) => console.error('sweepLateAttendance failed', e)));
    ctx.waitUntil(sweepOffHoursAvailability(env.DB, env).catch((e) => console.error('sweepOffHoursAvailability failed', e)));
    ctx.waitUntil(sweepOpsReports(env.DB, env).catch((e) => console.error('sweepOpsReports failed', e)));
    ctx.waitUntil(sweepAutoReclaim(env.DB, env).catch((e) => console.error('sweepAutoReclaim failed', e)));
    // خصم تأخير كتابة الملاحظة: تأخير الخصم بضع دقايق مش فارق عمليًا —
    // كل ١٥ دقيقة بدل ٥ يقلل ثلثي مرات فحص العملاء المتأخرين.
    if (isDueEvery(15, 5)) {
      ctx.waitUntil(sweepLateNotePenalty(env.DB, env).catch((e) => console.error('sweepLateNotePenalty failed', e)));
    }
    ctx.waitUntil(sweepMonthlyTopSales(env.DB, env).catch((e) => console.error('sweepMonthlyTopSales failed', e)));
  },
};
