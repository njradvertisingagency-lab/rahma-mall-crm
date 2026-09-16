// Shared D1 helpers: ID generation, activity logging, notifications, and the
// bridge into the TeamRoom Durable Object for real-time broadcast.

export function nowIso() {
  return new Date().toISOString();
}

/** Atomically reserve the next customer ID, e.g. RM-000042. */
export async function nextCustomerId(db) {
  const row = await db
    .prepare(`UPDATE counters SET value = value + 1 WHERE name = 'customer_seq' RETURNING value`)
    .first();
  const n = row.value;
  return 'RM-' + String(n).padStart(6, '0');
}

export async function nextDistributionLabel(db) {
  const row = await db
    .prepare(`UPDATE counters SET value = value + 1 WHERE name = 'distribution_seq' RETURNING value`)
    .first();
  return { seq: row.value, label: 'Distribution #' + String(row.value).padStart(3, '0') };
}

/** Append an immutable activity-log row. metadata is any JSON-serializable object. */
export async function logActivity(db, { actor, action, entityType, entityId, metadata }) {
  await db
    .prepare(
      `INSERT INTO activity_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      actor?.id ?? null,
      actor?.displayName ?? actor?.name ?? null,
      actor?.role ?? null,
      action,
      entityType ?? null,
      entityId ?? null,
      metadata ? JSON.stringify(metadata) : null
    )
    .run();
}

/** Persist a notification for one recipient user. Returns the inserted row id. */
export async function createNotification(db, { userId, type, title, message, entityType, entityId }) {
  const res = await db
    .prepare(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at`
    )
    .bind(userId, type, title, message, entityType ?? null, entityId ?? null)
    .first();
  return res;
}

/**
 * Broadcast a real-time event through the TeamRoom Durable Object.
 * `audience` selects which connected sockets receive it:
 *   { scope: 'all' }
 *   { scope: 'role', role: 'team_leader' }
 *   { scope: 'user', userId }
 *   { scope: 'employee', employeeId }
 *   { scope: 'users', userIds: [...] }
 */
export async function broadcast(env, event, payload, audience = { scope: 'all' }) {
  try {
    const id = env.TEAM_ROOM.idFromName('global');
    const stub = env.TEAM_ROOM.get(id);
    await stub.fetch('https://team-room.internal/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, payload, audience, ts: nowIso() }),
    });
  } catch (err) {
    // Real-time delivery is best-effort; the database remains the source of
    // truth and clients resync on reconnect, so a DO hiccup must never fail
    // the underlying mutation that already committed to D1.
    console.error('broadcast failed', err);
  }
}

export function jsonError(c, status, message, code) {
  return c.json({ error: { message, code: code ?? null } }, status);
}
