// Temporary "Do Not Disturb" — layered on top of the existing manual
// `availability` field (see routes/employees.js POST /:id/dnd). The employee
// picks a duration (e.g. a 60-minute lunch break); availability is set to
// UNAVAILABLE and dnd_until records when it should auto-revert. This cron
// sweep is the only thing that reverts it — nothing else touches dnd_until.
import { broadcast, nowIso } from './db.js';

export async function sweepDnd(db, env) {
  const now = nowIso();
  const expired = await db
    .prepare(`SELECT id FROM employees WHERE dnd_until IS NOT NULL AND dnd_until <= ? AND availability = 'UNAVAILABLE'`)
    .bind(now)
    .all();
  if (expired.results.length === 0) return { reverted: 0 };
  for (const emp of expired.results) {
    await db.prepare(`UPDATE employees SET availability = 'AVAILABLE', dnd_until = NULL, updated_at = ? WHERE id = ?`).bind(now, emp.id).run();
    await broadcast(env, 'EMPLOYEE_AVAILABILITY_CHANGED', { employeeId: emp.id, availability: 'AVAILABLE' }, { scope: 'role', role: 'team_leader' });
  }
  return { reverted: expired.results.length };
}
