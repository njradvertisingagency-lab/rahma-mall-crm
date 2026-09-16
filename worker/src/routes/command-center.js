import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth.js';
import { getCommandCenterSnapshot, getNeedsAttentionQueue } from '../lib/commandcenter.js';
import { getEmployeePresenceMap } from '../lib/presence.js';
import { computeAllEmployeeStats } from '../lib/performance.js';
import { getSeenSummaryByEmployee, getNotSeenCustomers } from '../lib/seen.js';
import { getReassignmentSuggestions } from '../lib/workqueue.js';

export const commandCenterRoutes = new Hono();
commandCenterRoutes.use('*', requireAuth, requireRole('team_leader'));

// One aggregate snapshot: team presence, today's sales, today's funnel, and
// the severity-ranked Needs Attention queue. Everything here is a live query
// — the page re-fetches this after any relevant real-time event so it never
// needs a manual refresh.
commandCenterRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const [snapshot, presenceMap, employeeStats, seenSummary] = await Promise.all([
    getCommandCenterSnapshot(db),
    getEmployeePresenceMap(db),
    computeAllEmployeeStats(db),
    getSeenSummaryByEmployee(db),
  ]);

  const liveEmployeeTable = employeeStats.stats.map((s) => ({
    id: s.employee.id,
    name: s.employee.name,
    nameAr: s.employee.nameAr,
    availability: s.employee.availability,
    presence: presenceMap[s.employee.id] || { online: false, activityState: 'OFFLINE' },
    assigned: s.assigned,
    closed: s.closed,
    followupsCompleted: s.followupsCompleted,
    followupsOverdue: s.followupsOverdue,
    completionRate: s.completionRate,
    performanceScore: s.performanceScore,
  }));

  return c.json({ ...snapshot, liveEmployeeTable, seenSummary });
});

commandCenterRoutes.get('/needs-attention', async (c) => {
  const items = await getNeedsAttentionQueue(c.env.DB);
  return c.json({ items });
});

commandCenterRoutes.get('/not-seen/:employeeId', async (c) => {
  const customers = await getNotSeenCustomers(c.env.DB, Number(c.req.param('employeeId')));
  return c.json({ customers });
});

// Suggest-only reassignment candidates (offline/on-break/repeated-SLA-breach
// employees still holding open customers). Executing a reassignment always
// goes through the existing manual POST /api/reassignments endpoint.
commandCenterRoutes.get('/reassignment-suggestions', async (c) => {
  const suggestions = await getReassignmentSuggestions(c.env.DB);
  return c.json({ suggestions });
});
