// Dedicated check-in/check-out attendance — visible to and usable by every
// authenticated account EXCEPT the owner (Mr. Hany doesn't clock in for his
// own business; the frontend hides the button for his account), separate
// from login/logout. Only /dashboard is gated to the owner account (Mr.
// Hany) — everyone else gets 403 there, same pattern as routes/opsreports.js.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { jsonError } from '../lib/db.js';
import { getMyAttendanceStatus, recordCheckIn, recordCheckOut, getAttendanceDashboard } from '../lib/attendance.js';
import { asList, asDelete } from '../lib/attendanceStore.js';

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
  if (!user.isOwner) return jsonError(c, 403, 'هذه الصفحة مخصّصة لحساب المالك فقط', 'FORBIDDEN_OWNER_ONLY');
  const date = c.req.query('date') || null;
  const dashboard = await getAttendanceDashboard(c.env, { date });
  return c.json(dashboard);
});

// ---------------------------------------------------------------------------
// أداة صيانة لمرة واحدة (طلب أ/ هاني): مسح كل أرقام الحضور/الانصراف/التأخير/
// العقوبات القديمة بالكامل لكل الموظفين، لأن الفترة اللي فاتت كانت تجربة
// للنظام ولسه الموظفين ميعرفوش يستخدموه صح. بعد التنفيذ، يُفضّل حذف هذا
// الراوت مرة أخرى (استخدام لمرة واحدة فقط) — لا يُستدعى من أي واجهة.
// ---------------------------------------------------------------------------
attendanceRoutes.post('/admin-wipe-all', async (c) => {
  const user = c.get('user');
  if (!user.isOwner) return jsonError(c, 403, 'هذه العملية مخصّصة لحساب المالك فقط', 'FORBIDDEN_OWNER_ONLY');
  const [attEntries, penEntries] = await Promise.all([asList(c.env, 'att:'), asList(c.env, 'pen:')]);
  for (const { key } of attEntries) await asDelete(c.env, key);
  for (const { key } of penEntries) await asDelete(c.env, key);
  return c.json({ ok: true, deletedAttendance: attEntries.length, deletedPenalties: penEntries.length });
});
