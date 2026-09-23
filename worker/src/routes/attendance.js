// Dedicated check-in/check-out attendance — visible to and usable by every
// authenticated account EXCEPT the owner (Mr. Hany doesn't clock in for his
// own business; the frontend hides the button for his account), separate
// from login/logout. Only /dashboard is gated to the owner account (Mr.
// Hany) — everyone else gets 403 there, same pattern as routes/opsreports.js.
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
  // Server-side backstop for the owner exclusion — the frontend already
  // hides the check-in button for this account, but that alone never stops
  // a stale cached page or a direct API call from writing a real attendance
  // record for an account the one dashboard that shows attendance
  // deliberately excludes (getAttendanceDashboard filters is_owner = 0),
  // which would otherwise create a phantom record nobody can ever see.
  if (user.isOwner) return jsonError(c, 403, 'حساب المالك لا يسجل حضورًا', 'FORBIDDEN_OWNER_ATTENDANCE');
  const result = await recordCheckIn(c.env, user);
  if (result.error) return jsonError(c, 409, result.message, result.error);
  return c.json(result);
});

attendanceRoutes.post('/check-out', async (c) => {
  const user = c.get('user');
  if (user.isOwner) return jsonError(c, 403, 'حساب المالك لا يسجل حضورًا', 'FORBIDDEN_OWNER_ATTENDANCE');
  const result = await recordCheckOut(c.env, user);
  if (result.error) return jsonError(c, 409, result.message, result.error);
  return c.json(result);
});

attendanceRoutes.get('/dashboard', async (c) => {
  const user = c.get('user');
  // كانت هذه الصفحة مقفولة على حساب المالك فقط — طلب أ/ هاني إتاحة نفس
  // جدول أداء الفريق (تقييم/تأخير/إنجاز لكل موظف) لحساب قائد الفريق أيضًا.
  if (!user.isOwner && user.role !== 'team_leader') return jsonError(c, 403, 'هذه الصفحة غير متاحة لحسابك', 'FORBIDDEN_OWNER_ONLY');
  const date = c.req.query('date') || null;
  const dashboard = await getAttendanceDashboard(c.env, { date });
  return c.json(dashboard);
});
