import { SESSION_COOKIE } from '../lib/auth.js';
import { sessGet } from '../lib/sessionStore.js';

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
 * Authenticates the WebSocket upgrade request against the SessionStore
 * Durable Object (see lib/sessionStore.js) BEFORE handing it to the
 * TeamRoom Durable Object — the DO itself never sees raw credentials, only
 * the verified identity the Worker attaches. This is the "never trust a
 * role supplied by the browser" rule applied to real-time connections too.
 * No D1 read at all — same reasoning as requireAuth in lib/auth.js.
 */
export async function handleWebSocketUpgrade(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return new Response('Not authenticated', { status: 401 });

  let session;
  try {
    session = await sessGet(env, token);
  } catch (err) {
    console.error('handleWebSocketUpgrade: session store unreachable', err);
    return new Response('Service unavailable', { status: 503 });
  }
  if (!session || !session.active) return new Response('Invalid session', { status: 401 });
  if (new Date(session.expiresAt).getTime() < Date.now()) return new Response('Session expired', { status: 401 });

  const identity = {
    userId: session.userId,
    role: session.role,
    employeeId: session.employeeId ?? null,
    displayName: session.displayName,
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
