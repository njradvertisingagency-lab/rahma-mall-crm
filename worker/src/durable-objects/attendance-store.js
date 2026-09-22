// AttendanceStore — a single global Durable Object holding every check-in/
// check-out attendance record and lateness penalty for the whole team.
//
// Why a Durable Object instead of a new D1 table: Cloudflare's D1 free-tier
// daily row-read quota was being exhausted by the live cron's own overhead
// (fixed separately — see the cron split in wrangler.toml/index.js), and
// even after that fix, adding new D1 tables needs at least one successful
// CREATE TABLE against D1 — which the quota kept blocking outright, and
// unpredictably (even a single-row read on an existing table sometimes
// failed). Durable Object storage is a COMPLETELY SEPARATE resource from
// D1 — creating and using this DO needs no D1 access at all — so the
// attendance system, Mr. Hany's dashboard, and the penalty system can work
// reliably today instead of depending on D1's quota ever cooperating.
//
// This DO is deliberately a plain generic key/value store (get/put/list by
// prefix, all namespaced under "att:"/"pen:" keys) — every actual business
// rule (lateness, the monthly penalty threshold, notifications) stays in
// worker/src/lib/attendance.js exactly as it would against a real D1 table,
// just calling this instead. Moving the data into a real D1 table later, if
// ever wanted, is a one-time export/import — not a rewrite.
export class AttendanceStore {
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
