// Dedicated check-in/check-out attendance — visible to and usable by every
// authenticated account (employee AND team_leader, including Mr. Hany's own
// admin account), separate from login/logout. Only /dashboard is gated to
// the owner account (Mr. Hany) — everyone else gets 403 there, same pattern
// as routes/opsreports.js.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { getMyAttendanceStatus, recordCheckIn, recordCheckOut, getAttendanceDashboard } from '../lib/attendance.js';

export const attendanceRoutes = new Hono();
attendanceRoutes.use('*', requireAuth);

attendanceRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const statusData = await getMyAttendanceStatus(c.env, user.id);
  return c.json(statusData);
});

attendanceRoutes.post('/check-in', async (c) => {
  const user = c.get('user');
  const result = await recordCheckIn(c.env, user);
  if (result.error) return jsonError(c, 409, result.message, result.error);
  return c.json(result);
});

attendanceRoutes.post('/check-out', async (c) => {
  const user = c.get('user');
  const result = await recordCheckOut(c.env, user);
  if (result.error) return jsonError(c, 409, result.message, result.error);
  return c.json(result);
});

attendanceRoutes.get('/dashboard', async (c) => {
  const user = c.get('user');
  if (!user.isOwner) return jsonError(c, 403, 'هذه الصفحة مخصّصة لحساب المالك فقط', 'FORBIDDEN_OWNER_ONLY');
  const date = c.req.query('date') || null;
  const dashboard = await getAttendanceDashboard(c.env, { date });
  return c.json(dashboard);
});
