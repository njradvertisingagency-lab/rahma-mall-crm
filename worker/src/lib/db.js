// Shared D1 helpers: ID generation, activity logging, notifications, and the
// bridge into the TeamRoom Durable Object for real-time broadcast.

export function nowIso() {
  return new Date().toISOString();
}

// D1 (Cloudflare's hosted SQLite) rejects a prepared statement with more than
// 100 bound parameters — a `WHERE id IN (...)` built by binding one `?` per
// array entry throws an uncaught error once the array passes 100 (e.g.
// distributing 100+ customers at once), which surfaces as a raw 500. Any
// `IN (...)` filter built from a caller-supplied array of unbounded size
// should use idsInClause/idsInJson below instead of one `?` per id.

/** `c.id IN (${idsInClause(...)})`-style placeholder — pass alongside idsInJson(ids) as the single bind value. */
export const idsInClause = () => 'SELECT value FROM json_each(?)';

/** The single bind value to pair with idsInClause(): a JSON array, safe for any number of ids. */
export const idsInJson = (ids) => JSON.stringify(ids ?? []);

/**
 * Runs `SELECT <selectSql> FROM <table> WHERE <idColumn> IN (SELECT value FROM json_each(?))`
 * (plus any extra fixed condition the caller appends via extraWhereSql/extraBinds), and returns
 * the rows. Safe for any number of ids — avoids D1's 100-bound-parameter limit entirely.
 */
export async function selectByIds(db, { table, idColumn = 'id', selectSql = '*', ids, extraWhereSql = '', extraBinds = [] }) {
  if (!ids || ids.length === 0) return [];
  const sql = `SELECT ${selectSql} FROM ${table} WHERE ${idColumn} IN (${idsInClause()})${extraWhereSql ? ' AND ' + extraWhereSql : ''}`;
  const res = await db.prepare(sql).bind(idsInJson(ids), ...extraBinds).all();
  return res.results;
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
  return { seq: row.value, label: 'توزيع رقم ' + String(row.value).padStart(3, '0') };
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

/**
 * Fire-and-forget a background write (refreshing a cache, touching a
 * last-seen timestamp). It must NEVER change what the caller returns.
 *
 * Reaching for `c.executionCtx` is itself risky: Hono exposes it as a getter
 * that THROWS when no execution context is attached to the request. When that
 * happens inside a `try` that also wraps a D1 query, the caller's catch block
 * treats it as a database failure — which is how a perfectly healthy database
 * ends up telling someone "try again in a few minutes" on the login screen.
 * So every step here is guarded: building the promise, attaching the
 * rejection handler, and asking for the execution context.
 */
export function backgroundWrite(c, makePromise, label) {
  let promise;
  try {
    promise = makePromise();
  } catch (err) {
    console.error(`${label}: background write threw synchronously (ignored)`, err);
    return;
  }
  if (!promise || typeof promise.catch !== 'function') return;

  // Swallow the rejection first, so the promise can never surface as an
  // unhandled rejection even if waitUntil below is unavailable.
  const settled = promise.catch((err) =>
    console.error(`${label}: background write failed (ignored)`, err)
  );

  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context on this request — the work is already in flight
    // and its failure is already handled, so simply let it run to completion.
  }
}
