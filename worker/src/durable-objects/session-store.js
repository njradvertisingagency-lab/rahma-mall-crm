// SessionStore — a single global Durable Object holding every login session
// token for the whole app (team leader, owner, and every employee).
//
// Why this exists: requireAuth() used to run `SELECT ... FROM sessions s
// JOIN users u ...` against D1 on EVERY single authenticated API request —
// meaning literally every click in the app cost at least one D1 read. When
// D1's free-tier daily row-read quota is exhausted (see the cron-overhead
// fix in wrangler.toml/index.js and AttendanceStore's own comment for the
// full story), that one query throws, Hono's default error handler turns it
// into a bare 500, and the ENTIRE app — every page, for every already
// logged-in person — goes down at once, not just the specific feature that
// happened to touch D1. That is a far bigger blast radius than any single
// feature, so session validation is moved off D1 entirely, onto this
// Durable Object, exactly like AttendanceStore's storage. Logging IN still
// needs one D1 read (to check the username/password), but every request
// AFTER that for the lifetime of the session no longer touches D1 at all.
//
// Same plain generic key/value interface as AttendanceStore (get/put/list/
// delete) — see that file's comment for why a DO instead of a new D1 table.
export class SessionStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;

    if (url.pathname === '/get') {
      const value = await this.state.storage.get(body.key);
      return Response.json({ value: value ?? null });
    }
    if (url.pathname === '/put') {
      await this.state.storage.put(body.key, body.value);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/list') {
      const map = await this.state.storage.list(body.prefix ? { prefix: body.prefix } : {});
      const entries = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
      return Response.json({ entries });
    }
    if (url.pathname === '/delete') {
      await this.state.storage.delete(body.key);
      return Response.json({ ok: true });
    }
    return new Response('غير موجود', { status: 404 });
  }
}
