import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logActivity, broadcast, jsonError, nowIso } from '../lib/db.js';
import { computeAllEmployeeStats, computeEmployeeCounters, getPerformanceWeights, computeScore } from '../lib/performance.js';
import { getEmployeeWorkQueue, getFollowupSuggestions } from '../lib/workqueue.js';
import { setDailyGoal, getDailyGoalProgress } from '../lib/dailygoals.js';

export const employeeRoutes = new Hono();
employeeRoutes.use('*', requireAuth);

const AVAILABILITY = ['AVAILABLE', 'BUSY', 'ON_BREAK', 'UNAVAILABLE'];

employeeRoutes.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  if (user.role === 'employee') {
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?`).bind(user.employeeId).first();
    const counters = await computeEmployeeCounters(db, user.employeeId);
    return c.json({ employees: [{ id: emp.id, name: emp.name, nameAr: emp.name_ar, availability: emp.availability, active: !!emp.active, ...counters }] });
  }
  const { weights, stats } = await computeAllEmployeeStats(db);
  return c.json({
    weights,
    employees: stats.map((s) => ({
      id: s.employee.id,
      name: s.employee.name,
      nameAr: s.employee.nameAr,
      availability: s.employee.availability,
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

employeeRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  if (user.role === 'employee' && user.employeeId !== id) {
    return jsonError(c, 403, 'You may only update your own availability', 'FORBIDDEN_OWNERSHIP');
  }
  if (user.role === 'employee' && ('active' in body)) {
    return jsonError(c, 403, 'Only the Team Leader can activate/deactivate employees', 'FORBIDDEN_ROLE');
  }

  const fields = [];
  const binds = [];
  if ('availability' in body) {
    if (!AVAILABILITY.includes(body.availability)) return jsonError(c, 400, 'Invalid availability value', 'INVALID_AVAILABILITY');
    fields.push('availability = ?');
    binds.push(body.availability);
  }
  if ('active' in body && user.role === 'team_leader') {
    fields.push('active = ?');
    binds.push(body.active ? 1 : 0);
  }
  if (fields.length === 0) return jsonError(c, 400, 'No fields to update', 'NO_FIELDS');
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
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'You may only view your own work queue', 'FORBIDDEN_OWNERSHIP');
  const queue = await getEmployeeWorkQueue(c.env.DB, id, Number(c.req.query('limit')) || 20);
  return c.json({ queue });
});

// Suggest-only follow-up recommendations (3+ unanswered call attempts, no
// open follow-up scheduled). Never auto-creates anything.
employeeRoutes.get('/:id/followup-suggestions', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'You may only view your own suggestions', 'FORBIDDEN_OWNERSHIP');
  const suggestions = await getFollowupSuggestions(c.env.DB, id);
  return c.json({ suggestions });
});

// Daily goal progress — computed live against real activity for the date.
employeeRoutes.get('/:id/daily-goal', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (user.role === 'employee' && user.employeeId !== id) return jsonError(c, 403, 'You may only view your own goal', 'FORBIDDEN_OWNERSHIP');
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
