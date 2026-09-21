import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';
import { computeAllEmployeeStats, computeEmployeeCounters, getPerformanceWeights, computeScore, getPerformanceHistory, computeBadges } from '../lib/performance.js';
import { getEmployeeWorkQueue, getFollowupSuggestions } from '../lib/workqueue.js';
import { setDailyGoal, getDailyGoalProgress } from '../lib/dailygoals.js';
import { hashPassword, randomSaltHex } from '../lib/passwords.js';

export const employeeRoutes = new Hono();
employeeRoutes.use('*', requireAuth);

const AVAILABILITY = ['AVAILABLE', 'BUSY', 'ON_BREAK', 'UNAVAILABLE'];

// Create a new employee account (user + employee profile in one step). Team
// Leader only — this is how new team members get onboarded without needing
// direct database access.
employeeRoutes.post('/', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const nameAr = body.nameAr ? String(body.nameAr).trim() : null;
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!name) return jsonError(c, 400, 'اسم الموظف مطلوب', 'MISSING_NAME');
  if (!username) return jsonError(c, 400, 'اسم المستخدم مطلوب', 'MISSING_USERNAME');
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
    return jsonError(c, 400, 'اسم المستخدم يجب أن يكون بالإنجليزية والأرقام فقط (٣ أحرف على الأقل)', 'INVALID_USERNAME');
  }
  if (password.length < 8) return jsonError(c, 400, 'يجب أن تتكون كلمة المرور من ٨ أحرف على الأقل', 'WEAK_PASSWORD');

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first();
  if (existing) return jsonError(c, 409, 'اسم المستخدم مستخدم بالفعل', 'USERNAME_TAKEN');

  const salt = randomSaltHex();
  const hash = await hashPassword(password, salt);
  const avatarInitial = name[0].toUpperCase();

  const newUser = await db
    .prepare(
      `INSERT INTO users (username, password_hash, password_salt, role, display_name, active, must_change_password)
       VALUES (?, ?, ?, 'employee', ?, 1, 0) RETURNING id`
    )
    .bind(username, hash, salt, name)
    .first();

  const newEmployee = await db
    .prepare(
      `INSERT INTO employees (user_id, name, name_ar, avatar_initial, availability, active)
       VALUES (?, ?, ?, ?, 'AVAILABLE', 1) RETURNING id`
    )
    .bind(newUser.id, name, nameAr, avatarInitial)
    .first();

  await logActivity(db, { actor: user, action: 'EMPLOYEE_CREATED', entityType: 'employee', entityId: String(newEmployee.id), metadata: { username, name } });
  return c.json({ ok: true, employeeId: newEmployee.id });
});

// Change an employee's username. Team Leader only.
employeeRoutes.patch('/:id/username', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();

  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
    return jsonError(c, 400, 'اسم المستخدم يجب أن يكون بالإنجليزية والأرقام فقط (٣ أحرف على الأقل)', 'INVALID_USERNAME');
  }
  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(id).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`).bind(username, emp.user_id).first();
  if (existing) return jsonError(c, 409, 'اسم المستخدم مستخدم بالفعل', 'USERNAME_TAKEN');

  await db.prepare(`UPDATE users SET username = ?, updated_at = ? WHERE id = ?`).bind(username, nowIso(), emp.user_id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_USERNAME_CHANGED', entityType: 'employee', entityId: String(id), metadata: { username } });
  return c.json({ ok: true, username });
});

// Change an employee's display name (English + optional Arabic). Team Leader
// only. Keeps three places in sync so the rename shows up everywhere at
// once: employees.name/name_ar (used across customer lists, distributions,
// reports), employees.avatar_initial (derived from the new name, unless a
// real photo is already set), and users.display_name (topbar, activity log
// actor names, chat).
employeeRoutes.patch('/:id/name', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const nameAr = body.nameAr != null ? String(body.nameAr).trim() : null;

  if (!name) return jsonError(c, 400, 'اسم الموظف مطلوب', 'MISSING_NAME');

  const emp = await db.prepare(`SELECT user_id, name AS oldName, name_ar AS oldNameAr, avatar_data_url FROM employees WHERE id = ?`).bind(id).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const avatarInitial = name[0].toUpperCase();
  await db.prepare(`UPDATE employees SET name = ?, name_ar = ?, avatar_initial = ?, updated_at = ? WHERE id = ?`).bind(name, nameAr, avatarInitial, nowIso(), id).run();
  await db.prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`).bind(name, nowIso(), emp.user_id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_NAME_CHANGED', entityType: 'employee', entityId: String(id), metadata: { from: { name: emp.oldName, nameAr: emp.oldNameAr }, to: { name, nameAr } } });
  return c.json({ ok: true, name, nameAr });
});

// Reset a forgotten password on the employee's behalf. Team Leader only —
// no need to know the old password, this is exactly the "employee forgot
// their password" recovery path.
employeeRoutes.post('/:id/reset-password', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const newPassword = String(body.newPassword || '');

  if (newPassword.length < 8) return jsonError(c, 400, 'يجب أن تتكون كلمة المرور من ٨ أحرف على الأقل', 'WEAK_PASSWORD');

  const emp = await db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(id).first();
  if (!emp) return jsonError(c, 404, 'الموظف غير موجود', 'NOT_FOUND');

  const salt = randomSaltHex();
  const hash = await hashPassword(newPassword, salt);
  await db
    .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?`)
    .bind(hash, salt, nowIso(), emp.user_id)
    .run();
  // Sign the employee out everywhere so a lost/leaked password can't keep an old session alive.
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(emp.user_id).run();

  await logActivity(db, { actor: user, action: 'EMPLOYEE_PASSWORD_RESET', entityType: 'employee', entityId: String(id) });
  return c.json({ ok: true });
});

employeeRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  if (user.role === 'employee') {
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?`).bind(user.employeeId).first();
    const counters = await computeEmployeeCounters(db, user.employeeId);
    return c.json({ employees: [{ id: emp.id, name: emp.name, nameAr: emp.name_ar, availability: emp.availability, dndUntil: emp.dnd_until, active: !!emp.active, avatarUrl: emp.avatar_data_url, ...counters }] });
  }
  const { weights, stats } = await computeAllEmployeeStats(db);
  const dndRows = await db.prepare(`SELECT id, dnd_until FROM employees WHERE active = 1`).all();
  const dndById = Object.fromEntries(dndRows.results.map((r) => [r.id, r.dnd_until]));
  return c.json({
    weights,
    employees: stats.map((s) => ({
      id: s.employee.id,
      name: s.employee.name,
      nameAr: s.employee.nameAr,
      username: s.employee.username,
      availability: s.employee.availability,
      dndUntil: dndById[s.employee.id] ?? null,
      avatarUrl: s.employee.avatarUrl,
      assigned: s.assigned,
      byStatus: s.byStatus,
      closed: s.closed,
      followupsTotal: s.followupsTotal,
      followupsCompleted: s.followupsCompleted,
      followupsOverdue: s.followupsOverdue,
      completionRate: s.completionRate,
      performanceScore: s.performanceScore,
      scoreBreakdown: s.scoreBreakdown,
    })),
  });
});

// Performance-over-time — a trend chart's data, not just today's snapshot.
employeeRoutes.get('/:id/performance-history', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط عرض أدائك الخاص', 'FORBIDDEN_OWNERSHIP');
  const days = Math.min(90, Math.max(7, Number(c.req.query('days')) || 30));
  const history = await getPerformanceHistory(c.env.DB, id, days);
  return c.json({ history });
});

// Achievements/badges — computed live from real data, never stored.
employeeRoutes.get('/badges', async (c) => {
  const badges = await computeBadges(c.env.DB);
  return c.json(badges);
});

// Team Leader activity/performance — owner-only oversight view. Unlike
// employee performance (which is scored against assigned customers), a
// Team Leader isn't "assigned" customers the same way, so this is a
// transparent activity rollup pulled straight from the existing audit
// trail (activity_logs) rather than an invented score.
employeeRoutes.get('/team-leader-performance', async (c) => {
  const user = c.get('user');
  if (!user.isOwner) return jsonError(c, 403, 'هذه الصفحة مخصّصة لحساب المالك فقط', 'FORBIDDEN_OWNER_ONLY');
  const db = c.env.DB;
  const leaders = await db.prepare(`SELECT id, username, display_name, is_owner FROM users WHERE role = 'team_leader'`).all();

  const rows = [];
  for (const tl of leaders.results) {
    const [customersCreated, customersImported, distributions, deals, employeesManaged, complaintsLogged, chatMessages, lastLogin, loginCount] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action = 'CUSTOMER_CREATED'`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action = 'CUSTOMERS_IMPORTED'`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action = 'DISTRIBUTION_CREATED'`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action = 'DEAL_DONE_CREATED'`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action IN ('EMPLOYEE_CREATED','EMPLOYEE_USERNAME_CHANGED','EMPLOYEE_PASSWORD_RESET')`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM complaints WHERE created_by = ?`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE sender_user_id = ?`).bind(tl.id).first(),
      db.prepare(`SELECT created_at FROM activity_logs WHERE actor_id = ? AND action = 'LOGIN' ORDER BY created_at DESC LIMIT 1`).bind(tl.id).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE actor_id = ? AND action = 'LOGIN'`).bind(tl.id).first(),
    ]);
    rows.push({
      userId: tl.id,
      username: tl.username,
      displayName: tl.display_name,
      isOwner: !!tl.is_owner,
      customersCreated: customersCreated.n,
      customersImported: customersImported.n,
      distributionsCreated: distributions.n,
      dealsRecorded: deals.n,
      employeesManaged: employeesManaged.n,
      complaintsLogged: complaintsLogged.n,
      chatMessagesSent: chatMessages.n,
      loginCount: loginCount.n,
      lastLoginAt: lastLogin?.created_at ?? null,
    });
  }
  return c.json({ teamLeaders: rows });
});

// Temporary "Do Not Disturb" — self-service only; the cron sweep (lib/dnd.js)
// auto-reverts to AVAILABLE once `minutes` elapses.
employeeRoutes.post('/:id/dnd', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط تفعيل عدم الإزعاج لنفسك', 'FORBIDDEN_OWNERSHIP');
  const body = await c.req.json().catch(() => ({}));
  const minutes = Number(body.minutes);
  if (!minutes || minutes <= 0 || minutes > 480) return jsonError(c, 400, 'عدد الدقائق غير صالح (الحد الأقصى ٨ ساعات)', 'INVALID_MINUTES');

  const until = new Date(Date.now() + minutes * 60000).toISOString();
  await db.prepare(`UPDATE employees SET availability = 'UNAVAILABLE', dnd_until = ?, updated_at = ? WHERE id = ?`).bind(until, nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_DND_STARTED', entityType: 'employee', entityId: String(id), metadata: { minutes, until } });
  await broadcast(c.env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: id, availability: 'UNAVAILABLE', dndUntil: until }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true, dndUntil: until });
});

// Cancel an active DND early — back to AVAILABLE right away.
employeeRoutes.post('/:id/dnd/cancel', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط إلغاء عدم الإزعاج لنفسك', 'FORBIDDEN_OWNERSHIP');
  await db.prepare(`UPDATE employees SET availability = 'AVAILABLE', dnd_until = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_DND_CANCELLED', entityType: 'employee', entityId: String(id) });
  await broadcast(c.env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: id, availability: 'AVAILABLE' }, { scope: 'role', role: 'team_leader' });
  return c.json({ ok: true });
});

employeeRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  if (user.role === 'employee' && user.employeeId !== id) {
    return jsonError(c, 403, 'يمكنك فقط تحديث إتاحتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  if (user.role === 'employee' && ('active' in body)) {
    return jsonError(c, 403, 'فقط قائد الفريق يمكنه تفعيل أو إيقاف الموظفين', 'FORBIDDEN_ROLE');
  }

  const fields = [];
  const binds = [];
  if ('availability' in body) {
    if (!AVAILABILITY.includes(body.availability)) return jsonError(c, 400, 'قيمة الإتاحة غير صالحة', 'INVALID_AVAILABILITY');
    fields.push('availability = ?');
    binds.push(body.availability);
    // Any manual availability change cancels a pending temporary DND — it
    // should never silently override a decision the employee/TL just made.
    fields.push('dnd_until = NULL');
  }
  if ('active' in body && user.role === 'team_leader') {
    fields.push('active = ?');
    binds.push(body.active ? 1 : 0);
  }
  if (fields.length === 0) return jsonError(c, 400, 'لا توجد حقول للتحديث', 'NO_FIELDS');
  fields.push('updated_at = ?');
  binds.push(nowIso(), id);

  await db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`).bind(...binds).run();

  if ('availability' in body) {
    await logActivity(db, { actor: user, action: 'EMPLOYEE_STATUS_CHANGED', entityType: 'employee', entityId: String(id), metadata: { availability: body.availability } });
    await broadcast(c.env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: id, availability: body.availability }, { scope: 'role', role: 'team_leader' });
  }
  return c.json({ ok: true });
});

// Smart priority queue — "Next Customers to Handle" for one employee, ranked
// by real, explicit signals (urgent flag, an actually-overdue follow-up,
// INTERESTED status, unanswered call streak). Employees may only view their
// own queue; the Team Leader may view anyone's.
employeeRoutes.get('/:id/work-queue', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط عرض قائمة مهامك الخاصة', 'FORBIDDEN_OWNERSHIP');
  const queue = await getEmployeeWorkQueue(c.env.DB, id, Number(c.req.query('limit')) || 20);
  return c.json({ queue });
});

// Suggest-only follow-up recommendations (3+ unanswered call attempts, no
// open follow-up scheduled). Never auto-creates anything.
employeeRoutes.get('/:id/followup-suggestions', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط عرض اقتراحاتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  const suggestions = await getFollowupSuggestions(c.env.DB, id);
  return c.json({ suggestions });
});

// Daily goal progress — computed live against real activity for the date.
employeeRoutes.get('/:id/daily-goal', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'يمكنك فقط عرض هدفك الخاص', 'FORBIDDEN_OWNERSHIP');
  const goalDate = c.req.query('date') || new Date().toISOString().slice(0, 10);
  const progress = await getDailyGoalProgress(c.env.DB, id, goalDate);
  return c.json({ progress });
});

// Setting a daily goal is a Team Leader action.
employeeRoutes.post('/:id/daily-goal', requireRole('team_leader'), async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const goalDate = body.goalDate || new Date().toISOString().slice(0, 10);
  const progress = await setDailyGoal(c.env.DB, {
    employeeId: id,
    goalDate,
    targetCustomers: Number(body.targetCustomers) || 0,
    targetSeen: Number(body.targetSeen) || 0,
    targetContacted: Number(body.targetContacted) || 0,
    targetFollowups: Number(body.targetFollowups) || 0,
    createdBy: user.id,
  });
  await logActivity(c.env.DB, { actor: user, action: 'DAILY_GOAL_SET', entityType: 'employee', entityId: String(id), metadata: { goalDate, ...body } });
  const targetEmployee = await c.env.DB.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(id).first();
  if (targetEmployee?.user_id) {
    await broadcast(c.env, 'DAILY_GOAL_SET', { employeeId: id, goalDate }, { scope: 'user', userId: targetEmployee.user_id });
  }
  return c.json({ progress });
});

// Profile photo — stored as a small compressed data: URL (the frontend
// resizes/crops to a square JPEG before upload), so no object-storage
// bucket is needed. Employees may only set/remove their own; the Team
// Leader may set/remove any employee's.
const MAX_AVATAR_DATA_URL_LENGTH = 400000; // ~300KB raw image after base64 overhead — generous for a compressed square thumbnail
employeeRoutes.post('/:id/avatar', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) {
    return jsonError(c, 403, 'يمكنك فقط تحديث صورتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  const body = await c.req.json().catch(() => ({}));
  const dataUrl = String(body.dataUrl || '');
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
    return jsonError(c, 400, 'صيغة الصورة غير صالحة', 'INVALID_IMAGE');
  }
  if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    return jsonError(c, 400, 'حجم الصورة كبير جدًا', 'IMAGE_TOO_LARGE');
  }
  await db.prepare(`UPDATE employees SET avatar_data_url = ?, updated_at = ? WHERE id = ?`).bind(dataUrl, nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_AVATAR_UPDATED', entityType: 'employee', entityId: String(id) });
  return c.json({ ok: true, avatarUrl: dataUrl });
});

employeeRoutes.delete('/:id/avatar', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) {
    return jsonError(c, 403, 'يمكنك فقط حذف صورتك الخاصة', 'FORBIDDEN_OWNERSHIP');
  }
  await db.prepare(`UPDATE employees SET avatar_data_url = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  await logActivity(db, { actor: user, action: 'EMPLOYEE_AVATAR_REMOVED', entityType: 'employee', entityId: String(id) });
  return c.json({ ok: true });
});
