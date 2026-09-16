import { SESSION_COOKIE } from '../lib/auth.js';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

/**
 * Authenticates the WebSocket upgrade request against D1 BEFORE handing it
 * to the Durable Object — the DO itself never sees raw credentials, only the
 * verified identity the Worker attaches. This is the "never trust a role
 * supplied by the browser" rule applied to real-time connections too.
 */
export async function handleWebSocketUpgrade(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return new Response('Not authenticated', { status: 401 });

  const db = env.DB;
  const session = await db
    .prepare(
      `SELECT s.user_id, s.expires_at, u.username, u.role, u.display_name, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .bind(token)
    .first();
  if (!session || !session.active) return new Response('Invalid session', { status: 401 });
  if (new Date(session.expires_at).getTime() < Date.now()) return new Response('Session expired', { status: 401 });

  let employeeId = null;
  if (session.role === 'employee') {
    const emp = await db.prepare(`SELECT id FROM employees WHERE user_id = ?`).bind(session.user_id).first();
    employeeId = emp?.id ?? null;
  }

  const identity = {
    userId: session.user_id,
    role: session.role,
    employeeId,
    displayName: session.display_name,
  };

  const id = env.TEAM_ROOM.idFromName('global');
  const stub = env.TEAM_ROOM.get(id);
  const doUrl = new URL('https://team-room.internal/websocket');
  return stub.fetch(doUrl, {
    headers: {
      Upgrade: 'websocket',
      'X-Rahma-Identity': JSON.stringify(identity),
    },
  });
}
