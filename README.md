# RAHMA MALL — Live Call Team CRM

A production Cloudflare-native CRM for the RAHMA MALL sales/call-team
operation: real-time customer distribution, WhatsApp contact tracking, an
advanced sales & call-team operating system (SLA rules, lead scoring, smart
work queues, daily goals, command center), and a full Deal Done / Purchase
tracking system (branch visits, purchases, refunds, attribution).

Built entirely on the Cloudflare stack:

- **Workers** (Hono router) — the API and static-asset host
- **D1** — the relational database (SQLite at the edge)
- **Durable Objects** (`TeamRoom`, WebSocket Hibernation API) — the real-time
  event bus that pushes live updates to every connected browser
- **Cron Triggers** — the once-a-minute sweep that turns UPCOMING follow-ups
  into OVERDUE, evaluates presence idle/offline state, and checks SLA
  warning/breach thresholds
- **Workers Assets** — serves the static SPA frontend (`frontend/public`)
  from the same Worker, so one deploy ships both the API and the UI

No external services, queues, or third-party backends are used anywhere in
this project — everything runs on Cloudflare's own primitives.

## Project layout

```
worker/src/index.js          Hono app entrypoint, route mounting, cron handler
worker/src/routes/*.js       One file per API resource (auth, customers, employees,
                              followups, distributions, sales, reports, ai, ...)
worker/src/lib/*.js          Business logic: passwords, presence, SLA, lead score,
                              sales math, funnel, command-center aggregation, AI, etc.
worker/src/durable-objects/team-room.js
                              The real-time WebSocket room (one global instance)
worker/migrations/*.sql      D1 schema migrations, applied in order
worker/seed/seed.sql         Auto-generated initial accounts + default settings
frontend/public/*.js         Vanilla-JS SPA (app.js = router/shell, views-*.js =
                              one file per page)
scripts/*.mjs                Test scripts: WebSocket, Playwright browser, seed
                              generation — see "Testing" below
wrangler.toml                Cloudflare bindings: D1, Durable Object, assets, cron
```

## Prerequisites

- Node.js 18+
- A Cloudflare account with Workers + D1 enabled
- `npm install` run once at the project root (installs `wrangler`, `hono`, `xlsx`)

## One-time Cloudflare setup

The D1 database for this project already exists on the target Cloudflare
account:

- Database name: `rahma_mall_db`
- Database ID: `254cf99d-8a08-4fcd-875a-a4abd67fc766`
- Already referenced in `wrangler.toml` under `[[d1_databases]]`

If you are standing this project up on a **different** Cloudflare account,
create your own database first and update `wrangler.toml`:

```bash
npx wrangler login
npx wrangler d1 create rahma_mall_db
# copy the returned database_id into wrangler.toml → [[d1_databases]] → database_id
```

### Apply schema migrations

Migrations live in `worker/migrations/` and must be applied in numeric
order (they are idempotent-safe `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` style where applicable, but should still only be
run once per environment):

```bash
# Local (SQLite file under .wrangler/state, for `npm run dev`)
npm run db:migrate:local

# Remote (the real, live Cloudflare D1 database)
npm run db:migrate:remote
```

This applies, in order:
1. `0001_init.sql` — core CRM tables (users, employees, customers, WhatsApp
   interactions, assignments, status history, notes, follow-ups, activity
   log, notifications, distributions, settings)
2. `0002_master_upgrade.sql` — advanced sales & call-team operating system
   tables (presence, sessions, customer-seen tracking, call attempts,
   product interest, SLA events, daily goals, saved filters)
3. `0003_sales_purchase_tracking.sql` — Deal Done & purchase tracking tables
   (branches, product catalog, branch visits, purchase transactions/items,
   refunds, attribution history, purchase audit log)

### Seed initial accounts and default settings

```bash
npm run db:seed:local    # local dev database
npm run db:seed:remote   # the real, live Cloudflare D1 database
```

This inserts the Team Leader account, 5 employee accounts, and default
settings (performance weights, distribution defaults, notification prefs,
WhatsApp template, SLA rules, lead-score weights, presence thresholds, sales
settings). All inserts use `ON CONFLICT ... DO NOTHING`, so re-running the
seed is always safe and will never duplicate or overwrite existing rows.

#### Initial login credentials

Every account is created with `must_change_password = 1`, so the app will
force a password change on first login. Rotate these immediately after
first login in any environment reachable outside the team:

| Username     | Password                    | Role         |
|--------------|------------------------------|--------------|
| `Teamleader` | `Rahmamallofficial199978518` | Team Leader  |
| `Ashrakat`   | `Ashrakat1559`               | Employee     |
| `Menna`      | `Menna1009`                  | Employee     |
| `Huda`       | `Huda1579`                   | Employee     |
| `Rahma`      | `Rahma1669`                  | Employee     |
| `Shimaa`     | `Shimaa1772`                 | Employee     |

To change any of these before seeding, edit `scripts/generate-seed.mjs` and
re-run `npm run seed:hash` to regenerate `worker/seed/seed.sql` with new
password hashes (plaintext passwords are never stored — only a PBKDF2-SHA256
hash + per-account salt land in the seed file and the database).

## Local development

```bash
npm run dev
```

Starts `wrangler dev --local` with state persisted to `.wrangler/state`
(so your local D1 data, presence state, etc. survive restarts). The app is
served at `http://localhost:8787`.

## Deploying to production

```bash
npm run deploy
```

This runs `wrangler deploy`, which:
1. Bundles `worker/src/index.js` and all its imports
2. Uploads the `TeamRoom` Durable Object class
3. Uploads the static assets in `frontend/public` (served via the `[assets]`
   binding, with SPA fallback so client-side routes work on refresh)
4. Registers the once-a-minute cron trigger
5. Publishes to your `*.workers.dev` subdomain (or a custom domain/route, if
   configured separately in the Cloudflare dashboard)

`wrangler deploy` requires the machine running it to be authenticated —
either via `npx wrangler login` (interactive browser OAuth) or by setting a
`CLOUDFLARE_API_TOKEN` environment variable to a token scoped at minimum to
`Workers Scripts: Edit`, `D1: Edit`, and `Account: Read` on the target
account.

### Alternative: deploying the frontend to Pages separately

If you'd rather serve the SPA from Cloudflare Pages and keep the Worker as a
pure API:

```bash
npm run pages:deploy
```

Then point the frontend's `API_BASE` (see `frontend/public/app.js`) at the
Worker's URL instead of using same-origin `/api/...` calls, and remove the
`[assets]` block from `wrangler.toml` if you no longer want the Worker to
serve static files.

## Secrets

The Worker mixes a server-side pepper into password hashing. Set it before
deploying to any shared environment:

```bash
npx wrangler secret put SESSION_HASH_SECRET
```

## Testing

All test scripts assume the local dev server (`npm run dev`) is running on
`http://localhost:8787`.

```bash
node scripts/ws-test.mjs                    # core real-time event smoke test
node scripts/ws-test-sales-presence.mjs     # two-client (TL + employee) real-time
                                             # scoping test: presence, call attempts,
                                             # lead score, branch visits, deal-done,
                                             # purchases, revenue — asserts exact
                                             # audience delivery with zero leakage
node scripts/browser-test.mjs               # Team Leader Playwright regression
node scripts/browser-test-employee.mjs      # Employee-role Playwright regression
node scripts/browser-test-new-frontend.mjs  # Command Center, saved filters,
                                             # segments, work queue, access control
node scripts/browser-test-deal-done.mjs     # full Customer 360 + Deal Done /
                                             # purchase confirmation flow
node scripts/browser-test-ai.mjs            # AI Assistant: daily summary,
                                             # operational insights, Q&A
```

Each Playwright script launches headless Chromium (pre-configured to use the
bundled `/opt/pw-browsers/chromium` binary), drives the real UI, and writes a
full-page screenshot to `/tmp` for visual verification.

## Feature overview

- **Core CRM**: customer import (Excel/CSV), auto-distribution across
  employees, manual reassignment, status pipeline, notes, follow-up
  scheduling, activity audit trail, notifications, real-time updates over
  WebSocket.
- **WhatsApp contact tracking**: per-customer WhatsApp interaction log,
  templated message generation with placeholders, contact history.
- **Advanced sales & call-team operating system**: employee presence
  (online/idle/offline via heartbeat + cron sweep), customer "seen" tracking
  with SLA timers, call-attempt logging with outcomes, product-interest
  tagging, rule-based lead scoring with a transparent reasons breakdown,
  configurable SLA rules with live breach/warning detection, smart
  (suggest-only, never automatic) work queues / follow-up suggestions /
  reassignment suggestions, daily goals with live progress tracking,
  saved filters, a Live Command Center dashboard, a rule-based AI Assistant
  that only answers from real data (never fabricates), and CSV export
  reports for every data domain.
- **Deal Done & purchase tracking**: branch catalog, product catalog,
  branch-visit logging, a full purchase/Deal Done flow with line items and
  live total computation, refunds (full/partial), attribution reassignment
  (with mandatory reason), void/cancel, an immutable purchase audit log, and
  per-employee sales attribution reporting (assigned → seen → contacted →
  interested → branch visit → deal, with conversion % and average order
  value).

All smart/suggestion features (work queue ranking, follow-up suggestions,
reassignment suggestions) are strictly **read-only recommendations** — no
backend logic ever auto-assigns, auto-contacts, or auto-modifies a customer.
Every state change requires an explicit action by a Team Leader or the
assigned employee through an audited endpoint.
