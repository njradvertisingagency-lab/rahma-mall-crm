// Admin-only ops reports — on-demand versions of the two automatic daily
// notifications in lib/opsreports.js. Gated on users.is_owner (Mr. Hany's
// admin account), never on role='team_leader' alone, so the regular Team
// Leader account gets a plain 403 here (and the topbar button that calls
// this never even renders for them — see app.js renderAdminReportsButton).
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { getStartOfDayReport, getEndOfShiftReport, formatStartOfDayMessage, formatEndOfShiftMessage } from '../lib/opsreports.js';

export const opsReportRoutes = new Hono();
opsReportRoutes.use('*', requireAuth);

function requireOwner(c) {
  const user = c.get('user');
  if (!user.isOwner) return jsonError(c, 403, 'هذه الصفحة مخصّصة لحساب المالك فقط', 'FORBIDDEN_OWNER_ONLY');
  return null;
}

opsReportRoutes.get('/start-of-day', async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const report = await getStartOfDayReport(c.env.DB);
  return c.json({ report, summary: formatStartOfDayMessage(report) });
});

opsReportRoutes.get('/end-of-shift', async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const report = await getEndOfShiftReport(c.env.DB);
  return c.json({ report, summary: formatEndOfShiftMessage(report) });
});
