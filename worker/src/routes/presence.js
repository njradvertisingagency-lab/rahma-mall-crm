import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { recordHeartbeat, getEmployeePresence, getEmployeePresenceMap, getEmployeeOnlineTimeSummary } from '../lib/presence.js';
import { jsonError } from '../lib/db.js';

export const presenceRoutes = new Hono();
presenceRoutes.use('*', requireAuth);

// Sent periodically by the client while the tab is visible and the user has
// interacted recently (mouse/keyboard/scroll/touch — see app.js). This is the
// ONLY thing that can move an employee back to ACTIVE / keep them ONLINE;
// nothing here is inferred or guessed server-side.
presenceRoutes.post('/heartbeat', async (c) => {
  const user = c.get('user');
  if (!user.employeeId) return c.json({ ok: true, activityState: null }); // Team Leader: no presence row to update
  const db = c.env.DB;
  const result = await recordHeartbeat(db, c.env, user.employeeId);
  return c.json({ ok: true, ...result });
});

presenceRoutes.get('/me', async (c) => {
  const user = c.get('user');
  if (!user.employeeId) return c.json({ presence: null, onlineTime: null });
  const [presence, onlineTime] = await Promise.all([
    getEmployeePresence(c.env.DB, user.employeeId),
    getEmployeeOnlineTimeSummary(c.env.DB, user.employeeId),
  ]);
  return c.json({ presence, onlineTime });
});

presenceRoutes.get('/team', requireRole('team_leader'), async (c) => {
  const map = await getEmployeePresenceMap(c.env.DB);
  return c.json({ presence: map });
});
