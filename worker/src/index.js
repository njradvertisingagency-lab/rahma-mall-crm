import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAppHeader } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { customerRoutes } from './routes/customers.js';
import { interestedRoutes } from './routes/interested.js';
import { distributionRoutes, reassignmentRoutes } from './routes/distributions.js';
import { followupRoutes, sweepOverdueFollowups } from './routes/followups.js';
import { activityRoutes } from './routes/activity.js';
import { analyticsRoutes } from './routes/analytics.js';
import { reportRoutes } from './routes/reports.js';
import { employeeRoutes } from './routes/employees.js';
import { settingsRoutes } from './routes/settings.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { presenceRoutes } from './routes/presence.js';
import { salesRoutes } from './routes/sales.js';
import { commandCenterRoutes } from './routes/command-center.js';
import { savedFilterRoutes } from './routes/saved-filters.js';
import { opsReportRoutes } from './routes/opsreports.js';
import { attendanceRoutes } from './routes/attendance.js';
import { rewardsRoutes } from './routes/rewards.js';
import { dailyReportRoutes } from './routes/daily-report.js';
import { legalFileRoutes } from './routes/legal-files.js';
import { handleWebSocketUpgrade } from './routes/ws.js';
import { sweepPresence } from './lib/presence.js';
import { recordDailySnapshots } from './lib/performance.js';
import { sweepDnd } from './lib/dnd.js';
import { sweepOffHoursAvailability, getCairoNow, getCairoWeekday, isDueEvery } from './lib/workhours.js';
import { sweepAutoReclaim, sweepRedistribute3pm, sweepAutoDistribute, sweepPurgeNotInterested } from './lib/reclaim.js';
import { sweepLateNotePenalty, sweepMonthlyTopSales } from './lib/motivation.js';

export { TeamRoom } from './durable-objects/team-room.js';
export { AttendanceStore } from './durable-objects/attendance-store.js';
export { SessionStore } from './durable-objects/session-store.js';

const app = new Hono();

// Security headers on every response.
app.use('*', async (c, next) => {
  await next();
  // A WebSocket upgrade response (status 101) has immutable headers â skip it.
  if (c.res && c.res.status !== 101) {
    try {
      c.res.headers.set('X-Content-Type-Options', 'nosniff');
      c.res.headers.set('X-Frame-Options', 'DENY');
      c.res.headers.set('Referrer-Policy', 'same-origin');
    } catch {
      // Some responses (e.g. streamed) may still refuse header mutation â non-fatal.
    }
  }
});

// CORS support for the split-origin production deployment (frontend on
// Cloudflare Pages, API on this Worker's own workers.dev domain). Local dev
// serves both from the same origin via the [assets] binding, so this only
// matters for cross-origin browsers â credentials must be explicitly
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
api.route('/interested', interestedRoutes);
api.route('/distributions', distributionRoutes);
api.route('/reassignments', reassignmentRoutes);
api.route('/followups', followupRoutes);
api.route('/activity', activityRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/reports', reportRoutes);
api.route('/employees', employeeRoutes);
api.route('/settings', settingsRoutes);
api.route('/whatsapp', whatsappRoutes);
api.route('/presence', presenceRoutes);
api.route('/sales', salesRoutes);
api.route('/command-center', commandCenterRoutes);
api.route('/saved-filters', savedFilterRoutes);
api.route('/rewards', rewardsRoutes);
api.route('/ops-reports', opsReportRoutes);
api.route('/attendance', attendanceRoutes);
api.route('/daily-report', dailyReportRoutes);
api.route('/legal-files', legalFileRoutes);
app.route('/api', api);

// Real-time WebSocket upgrade â authenticated in routes/ws.js before ever
// reaching the Durable Object.
app.get('/ws', (c) => handleWebSocketUpgrade(c.req.raw, c.env));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path === '/ws') {
    return c.json({ error: { message: 'ØºÙØ± ÙÙØ¬ÙØ¯' } }, 404);
  }
  // Fall through to static assets (the SPA's index.html handles client routes).
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404);
});

// A database outage is the one failure this app hits in normal operation:
// D1's free tier caps daily row reads, and once that cap is reached EVERY
// query throws until it resets at midnight UTC. Individual hot endpoints
// cache their last good payload and degrade on their own, but there are far
// too many queries app-wide to guard each one by hand â and an unguarded
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
            'ØªØ¹Ø°Ø± ØªØ­ÙÙÙ Ø§ÙØ¨ÙØ§ÙØ§Øª ÙØ¤ÙØªÙØ§ Ø¨Ø³Ø¨Ø¨ Ø¶ØºØ· Ø¹ÙÙ ÙØ§Ø¹Ø¯Ø© Ø§ÙØ¨ÙØ§ÙØ§Øª â Ø¨Ø±Ø¬Ø§Ø¡ Ø§ÙÙØ­Ø§ÙÙØ© Ø®ÙØ§Ù Ø¯ÙØ§Ø¦Ù',
          code: 'DB_TEMPORARILY_UNAVAILABLE',
        },
      },
      503
    );
  }

  return c.json(
    {
      error: {
        message: 'Ø­Ø¯Ø« Ø®Ø·Ø£ ØºÙØ± ÙØªÙÙØ¹ â Ø¨Ø±Ø¬Ø§Ø¡ Ø§ÙÙØ­Ø§ÙÙØ© ÙØ±Ø© Ø£Ø®Ø±Ù',
        code: 'INTERNAL_ERROR',
      },
    },
    500
  );
});

// The shift is 10:00â18:00 Cairo, Thursday and Friday off. The sweep window
// is deliberately wider than the shift at both ends, because a few sweeps
// must fire just OUTSIDE it: the pre-shift availability restore runs before
// 10:00, and the end-of-shift ops report plus the idle-customer auto-reclaim
// both only run at or after 18:00. The margins below give each of those
// plenty of ticks to land.
//
// These bounds are intentionally hardcoded and D1-free: reading the
// configurable work_hours row on every tick would cost the very reads this
// gate exists to save. If the shift ever moves far outside 09:30â19:30,
// widen this window to match â the settings row alone will not move it.
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
    // stopping all automation â a wasted tick is cheaper than a missed alert.
    console.error('sweep window check failed, running sweeps anyway', err);
    return true;
  }
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  // Cron trigger â TWO cadences (see wrangler.toml for why): "* * * * *"
  // every minute for the one thing worth checking that often (presence),
  // and "*/5 * * * *" every 5 minutes for everything else. Each sweep stays
  // isolated so one failing never blocks the others.
  async scheduled(event, env, ctx) {
    // Every sweep below exists to watch employees while they work. Outside
    // the shift there is nobody to watch, yet the crons still fired around
    // the clock â 1,440 + 288 runs a day, every day, each one reading D1.
    // That is the bulk of the daily read quota spent on empty office hours,
    // which is why the quota kept running out mid-morning.
    //
    // Skipping the idle hours is safe because no sweep needs to fire at an
    // exact minute: each one already carries its own same-day dedup guard,
    // and the states they set (off-hours DND, availability) simply persist
    // overnight untouched, which is the correct resting state anyway.
    // ØªÙØ¸ÙÙ Ø§ÙØ®ÙÙØ³ Ù¡Ù¢:Ù Ù : Ø­Ø°Ù Ø§ÙØ¹ÙÙØ§Ø¡ "ØºÙØ± ÙÙØªÙ" (Ø§ÙØ®ÙÙØ³ Ø¥Ø¬Ø§Ø²Ø© ÙØ§ÙÙ sweeps Ø§ÙØ¹Ø§Ø¯ÙØ© ÙØ§ÙÙØ©).
    if (event.cron === '* * * * *' && getCairoWeekday() === 'Thursday') {
      const m = getCairoNow().minutesSinceMidnight;
      if (m >= 12 * 60 && m <= 12 * 60 + 2) {
        ctx.waitUntil(sweepPurgeNotInterested(env.DB).catch((e) => console.error('sweepPurgeNotInterested failed', e)));
      }
    }
    if (!sweepsShouldRunNow()) return;

    if (event.cron === '* * * * *') {
      // ÙØ§ÙØª ÙÙ Ø¯ÙÙÙØ© (Ù¡Ù¤Ù¤Ù  ØªØ´ØºÙÙØ©/ÙÙÙ) â Ø£ÙÙ Ø³Ø¨Ø¨ ÙÙ Ø§Ø³ØªÙÙØ§Ù Ø­ØµØ© Ø§ÙÙØ±Ø§Ø¡Ø©
      // Ø§ÙÙØ¬Ø§ÙÙØ© Ø§ÙÙÙÙÙØ©. Ø§ÙØªÙØ§Ø¬Ø¯ (presence) ÙØ§ ÙØ­ØªØ§Ø¬Ø´ Ø¯ÙØ© Ø¯ÙÙÙØ© Ø¨Ø¯ÙÙÙØ©Ø
      // ÙÙ Ù£ Ø¯ÙØ§ÙÙ ÙØ§ÙÙ Ø¬Ø¯ÙØ§ ÙØ¨ÙÙÙØ± Ø«ÙØ«Ù Ø§ÙÙØ±Ø§Ø¡Ø§Øª ÙÙ ØºÙØ± ÙØ§ Ø­Ø¯ ÙØ­Ø³ Ø¨ÙØ±Ù.
      if (isDueEvery(3, 1)) {
        ctx.waitUntil(sweepPresence(env.DB, env).catch((e) => console.error('sweepPresence failed', e)));
      }
      // Ø¥Ø¹Ø§Ø¯Ø© Ø§ÙØªÙØ²ÙØ¹ Ø§ÙØ³Ø§Ø¹Ø© Ù£ Ø¨Ø§ÙØ¸Ø¨Ø·: Ø§ÙØªØ´ØºÙÙ Ø§ÙØ£ÙÙ ÙÙ Ø£ÙÙ Ø¯ÙÙÙØ© ÙÙ Ø§ÙØ³Ø§Ø¹Ø© Ù£
      // (ÙØ§ÙØ¯ÙÙÙØªÙÙ Ø§ÙÙÙ Ø¨Ø¹Ø¯ÙØ§ ÙØ§Ø­ØªÙØ§Ø· ÙÙ ØªØ£Ø®Ø± Ø§ÙÙ cron). Ø¨Ø¹Ø¯ Ø£ÙÙ ÙØ¬Ø§Ø­
      // Ø§ÙÙ dedup Ø¨ÙÙÙØ¹ Ø§ÙØªÙØ±Ø§Ø±Ø ÙØ§ÙÙ */5 ÙØ§Ø¶Ù ÙØ´Ø¨ÙØ© Ø£ÙØ§Ù ÙÙ ÙØ§Øª Ø§ÙÙÙØ¹Ø¯.
      const nowMin = getCairoNow().minutesSinceMidnight;
      if (nowMin >= 16 * 60 && nowMin <= 16 * 60 + 2) {
        ctx.waitUntil(sweepRedistribute3pm(env.DB, env).catch((e) => console.error('sweepRedistribute3pm failed', e)));
      }
      // Ø§ÙØªÙØ²ÙØ¹ Ø§ÙØªÙÙØ§Ø¦Ù Ø§ÙØµØ¨Ø­ Ù¡Ù¡:Ù£Ù  (ÙÙØ³ ÙÙØ±Ø© Ø§ÙØ¯ÙÙÙØªÙÙ Ø§ÙØ§Ø­ØªÙØ§Ø·).
      if (nowMin >= 11 * 60 + 30 && nowMin <= 11 * 60 + 32) {
        ctx.waitUntil(sweepAutoDistribute(env.DB, env).catch((e) => console.error('sweepAutoDistribute failed', e)));
      }
      return;
    }
    // '*/5 * * * *' (or any other/unrecognized cron â safe default so a
    // future trigger never silently runs nothing).
    // sweeps Ø§ÙÙ SLA ÙØ§ÙÙ CUSTOMER_WAITING Ø§ØªØ´Ø§ÙØª â ÙØ§ÙØª ÙÙØ¬ÙØ¯Ø© ÙÙØ¥Ø´Ø¹Ø§Ø±Ø§Øª Ø¨Ø³ (Ø§ÙØ­Ø§ÙØ© Ø§ÙØ­ÙØ© Ø¨ØªØªØ­Ø³Ø¨ ÙÙ Ø§ÙØ·ÙØ§Ø¨Ø¹ Ø§ÙØ²ÙÙÙØ© ÙØ¨Ø§Ø´Ø±Ø©).
    ctx.waitUntil(sweepOverdueFollowups(env).catch((e) => console.error('sweepOverdueFollowups failed', e)));
    // ÙØ§ÙØª Ø¨ØªØ´ØªØºÙ ÙÙ Ù¥ Ø¯ÙØ§ÙÙ ÙØ¨ØªØ¹ÙÙ Ù¤ Ø§Ø³ØªØ¹ÙØ§ÙØ§Øª ÙÙÙ ÙÙØ¸Ù ÙØ´Ø· ÙÙ ÙÙ ØªØ´ØºÙÙØ© â
    // Ø£ÙØ¨Ø± ÙØ³ØªÙÙÙ ÙØ­ØµØ© Ø§ÙÙØ±Ø§Ø¡Ø© Ø§ÙÙÙÙÙØ© Ø¨Ø§ÙÙØ§ÙÙ. Ø§ÙØ¨ÙØ§ÙØ§Øª Ø¯Ù ÙØ±Ø³Ù Ø¨ÙØ§ÙÙ
    // ØªØ§Ø±ÙØ®Ù (trend chart) ÙØ´ Ø´Ø§Ø´Ø© ÙØ§ÙÙØ ÙÙØ±Ø© ÙÙ Ø³Ø§Ø¹Ø© ÙØ§ÙÙØ© ØªÙØ§ÙÙØ§ ÙØ¨ØªÙÙØ±
    // Ù©Ù¢Ùª ÙÙ ÙØ±Ø§Ø¡Ø§Øª ÙØ°Ø§ Ø§ÙØ¬Ø²Ø¡ ØªØ­Ø¯ÙØ¯ÙØ§.
    if (isDueEvery(180, 5)) {
      ctx.waitUntil(recordDailySnapshots(env.DB).catch((e) => console.error('recordDailySnapshots failed', e)));
    }
    ctx.waitUntil(sweepDnd(env.DB, env).catch((e) => console.error('sweepDnd failed', e)));
    ctx.waitUntil(sweepOffHoursAvailability(env.DB, env).catch((e) => console.error('sweepOffHoursAvailability failed', e)));
    ctx.waitUntil(sweepAutoReclaim(env.DB, env).catch((e) => console.error('sweepAutoReclaim failed', e)));
    ctx.waitUntil(sweepRedistribute3pm(env.DB, env).catch((e) => console.error('sweepRedistribute3pm failed', e)));
    // Ø®ØµÙ ØªØ£Ø®ÙØ± ÙØªØ§Ø¨Ø© Ø§ÙÙÙØ§Ø­Ø¸Ø©: ØªØ£Ø®ÙØ± Ø§ÙØ®ØµÙ Ø¨Ø¶Ø¹ Ø¯ÙØ§ÙÙ ÙØ´ ÙØ§Ø±Ù Ø¹ÙÙÙÙØ§ â
    // ÙÙ Ù¡Ù¥ Ø¯ÙÙÙØ© Ø¨Ø¯Ù Ù¥ ÙÙÙÙ Ø«ÙØ«Ù ÙØ±Ø§Øª ÙØ­Øµ Ø§ÙØ¹ÙÙØ§Ø¡ Ø§ÙÙØªØ£Ø®Ø±ÙÙ.
    if (isDueEvery(15, 5)) {
      ctx.waitUntil(sweepLateNotePenalty(env.DB, env).catch((e) => console.error('sweepLateNotePenalty failed', e)));
    }
    if (isDueEvery(60, 5)) {
      ctx.waitUntil(sweepMonthlyTopSales(env.DB, env).catch((e) => console.error('sweepMonthlyTopSales failed', e)));
    }
  },
};
