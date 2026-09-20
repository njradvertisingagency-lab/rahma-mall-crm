// TeamRoom — a single global Durable Object instance that fans out
// real-time events to every connected, authenticated client. Uses the
// WebSocket Hibernation API so idle connections cost nothing while still
// being addressable, and survives the DO being evicted/restarted.
//
// Security model: the Worker (see routes/ws.js) authenticates the session
// BEFORE calling this DO, and passes the verified identity in via a header
// on the internal upgrade request. This DO never trusts anything a client
// sends about who it is — only what the Worker told it at accept time.

export class TeamRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const { event, payload, audience, ts } = await request.json();
      this.deliver(event, payload, audience, ts);
      return new Response('ok');
    }

    if (url.pathname === '/websocket') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('مطلوب اتصال websocket', { status: 426 });
      }
      const identity = JSON.parse(request.headers.get('X-Rahma-Identity') || '{}');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      server.serializeAttachment(identity);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('غير موجود', { status: 404 });
  }

  /** Push `{ type: event, payload, ts }` to every socket matched by `audience`. */
  deliver(event, payload, audience, ts) {
    const sockets = this.state.getWebSockets();
    const message = JSON.stringify({ type: event, payload, ts: ts || new Date().toISOString() });
    for (const ws of sockets) {
      let identity;
      try {
        identity = ws.deserializeAttachment();
      } catch {
        identity = null;
      }
      if (!identity) continue;
      if (this.matches(identity, audience)) {
        try {
          ws.send(message);
        } catch {
          // Socket is closing/broken; the hibernation API will clean it up.
        }
      }
    }
  }

  matches(identity, audience) {
    if (!audience || audience.scope === 'all') return true;
    if (audience.scope === 'role') return identity.role === audience.role;
    if (audience.scope === 'user') return identity.userId === audience.userId;
    if (audience.scope === 'users') return (audience.userIds || []).includes(identity.userId);
    if (audience.scope === 'employee') return identity.employeeId === audience.employeeId;
    return false;
  }

  // Hibernation API lifecycle hooks — required to exist even if unused.
  async webSocketMessage(ws, message) {
    // The client may send lightweight control frames (e.g. a ping to keep
    // the connection warm / verify liveness). We don't require it, but
    // answer it so a client-side heartbeat has something to check.
    try {
      const data = JSON.parse(typeof message === 'string' ? message : '');
      if (data && data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
      }
    } catch {
      // Ignore malformed client frames.
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Nothing to persist — connection membership lives only in the live
    // WebSocket set the Hibernation API already tracks for us.
  }

  async webSocketError(ws, error) {
    // Swallow; the socket will be closed by the runtime.
  }
}
