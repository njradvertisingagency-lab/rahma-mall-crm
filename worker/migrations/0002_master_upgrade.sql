-- RAHMA MALL — MASTER UPGRADE (Advanced Sales & Call Team Operating System)
-- Adds: employee presence/session history, per-employee customer Seen tracking,
-- call attempts, product interest (multi), SLA breach/warning audit log,
-- daily employee goals, and saved filters. Lead score and dynamic segments are
-- computed live from existing + these tables (never stored/cached) so they can
-- never go stale — same principle already used for OVERDUE follow-up detection.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- EMPLOYEE PRESENCE (one live row per employee — automatic, activity-based)
-- Distinct from employees.availability, which stays the employee's own manual
-- self-declared status (AVAILABLE/BUSY/ON_BREAK/UNAVAILABLE) used for
-- distribution routing. Presence here is derived from real signals: login,
-- logout, WebSocket connectivity and a client activity heartbeat — never
-- set directly by a user action.
-- =====================================================================
CREATE TABLE IF NOT EXISTS employee_presence (
  employee_id                 INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  online                      INTEGER NOT NULL DEFAULT 0,
  activity_state              TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (activity_state IN ('ACTIVE','IDLE','OFFLINE')),
  last_login_at               TEXT,
  last_logout_at              TEXT,
  last_activity_at            TEXT,
  current_session_token       TEXT,
  current_session_started_at  TEXT,
  -- Accounting model: total_active/idle_seconds accumulate the elapsed time
  -- each time activity_state transitions (login/heartbeat/idle-sweep/logout).
  -- last_state_change_at anchors that accumulation, so nothing is ever double-
  -- counted or lost between transitions.
  last_state_change_at        TEXT,
  total_active_seconds        INTEGER NOT NULL DEFAULT 0,
  total_idle_seconds          INTEGER NOT NULL DEFAULT 0,
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =====================================================================
-- EMPLOYEE SESSION HISTORY (append-only; never deleted, unlike the auth
-- `sessions` cookie table which is deleted on logout for security). Powers
-- "last login/logout", "session duration", "previous sessions" reporting.
-- =====================================================================
CREATE TABLE IF NOT EXISTS employee_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE,  -- NULL for Team Leader
  session_token TEXT NOT NULL,
  device        TEXT,          -- parsed from User-Agent, e.g. "Desktop", "Mobile", "Tablet"
  browser       TEXT,          -- parsed from User-Agent, e.g. "Chrome", "Safari"
  login_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  logout_at     TEXT,          -- NULL while the session is still open
  last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  duration_seconds INTEGER     -- filled in on logout/expiry
);
CREATE INDEX IF NOT EXISTS idx_empsessions_user ON employee_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_empsessions_employee ON employee_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_empsessions_login ON employee_sessions(login_at);
CREATE INDEX IF NOT EXISTS idx_empsessions_token ON employee_sessions(session_token);

-- =====================================================================
-- CUSTOMER SEEN (per customer PER EMPLOYEE — not global). A customer reassigned
-- to a new employee is naturally "not seen" for that employee simply because no
-- row exists yet for that pair; the previous employee's seen record is kept.
-- Recorded ONLY when the employee actually opens the customer's detail page,
-- never on list-load (see routes/customers.js :id handler).
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_seen (
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (customer_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_customerseen_employee ON customer_seen(employee_id);
CREATE INDEX IF NOT EXISTS idx_customerseen_seenat ON customer_seen(seen_at);

-- =====================================================================
-- CALL ATTEMPTS (append-only; explicit user action — there is no telephony
-- integration, so an "attempt" is only ever logged when the employee actually
-- records one, with a real outcome they choose. Never inferred/fabricated.)
-- =====================================================================
CREATE TABLE IF NOT EXISTS call_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id),
  attempted_by  INTEGER REFERENCES users(id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ANSWERED','NO_ANSWER','BUSY','WRONG_NUMBER','SWITCHED_OFF','REJECTED')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_callattempts_customer ON call_attempts(customer_id);
CREATE INDEX IF NOT EXISTS idx_callattempts_employee ON call_attempts(employee_id);
CREATE INDEX IF NOT EXISTS idx_callattempts_created ON call_attempts(created_at);

-- =====================================================================
-- PRODUCT INTEREST (a customer may be interested in more than one product;
-- customers.product is kept as-is for backward compatibility / import default).
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(customer_id, product)
);
CREATE INDEX IF NOT EXISTS idx_customerproducts_customer ON customer_products(customer_id);
CREATE INDEX IF NOT EXISTS idx_customerproducts_product ON customer_products(product);

-- Backfill: carry each customer's existing single `product` column into the
-- new multi-product table so nothing already imported is lost.
INSERT OR IGNORE INTO customer_products (customer_id, product)
SELECT id, product FROM customers WHERE product IS NOT NULL AND TRIM(product) != '';

-- =====================================================================
-- SLA EVENTS (audit + notification-dedup log; the LIVE sla state shown in the
-- UI is always recomputed on the fly from real timestamps against the
-- configurable thresholds in settings — this table exists only so the cron
-- sweep can notify once per breach instead of re-notifying every sweep, and
-- so a historical SLA audit trail exists).
-- =====================================================================
CREATE TABLE IF NOT EXISTS sla_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id),
  rule          TEXT NOT NULL CHECK (rule IN ('SEEN_SLA','CONTACT_SLA','INTERESTED_FOLLOWUP_SLA','FOLLOWUP_DUE_SLA')),
  level         TEXT NOT NULL CHECK (level IN ('WARNING','BREACHED')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_slaevents_customer ON sla_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_slaevents_created ON sla_events(created_at);
CREATE INDEX IF NOT EXISTS idx_slaevents_unresolved ON sla_events(customer_id, rule, resolved_at);

-- =====================================================================
-- DAILY EMPLOYEE GOALS (set explicitly by the Team Leader; never auto-generated)
-- =====================================================================
CREATE TABLE IF NOT EXISTS daily_goals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  goal_date          TEXT NOT NULL,   -- 'YYYY-MM-DD'
  target_customers   INTEGER NOT NULL DEFAULT 0,
  target_seen        INTEGER NOT NULL DEFAULT 0,
  target_contacted   INTEGER NOT NULL DEFAULT 0,
  target_followups   INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(employee_id, goal_date)
);
CREATE INDEX IF NOT EXISTS idx_dailygoals_date ON daily_goals(goal_date);

-- =====================================================================
-- SAVED FILTERS (per user; Team Leader or employee can save their own combined
-- filter sets, e.g. "Interested + Overdue")
-- =====================================================================
CREATE TABLE IF NOT EXISTS saved_filters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  query        TEXT NOT NULL,   -- JSON of filter params (querystring-shaped)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, name)
);

-- =====================================================================
-- Extra indexes called for by the master upgrade spec (most already exist;
-- these are the new ones).
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_customers_source ON customers(source);
CREATE INDEX IF NOT EXISTS idx_customers_campaign ON customers(campaign);
CREATE INDEX IF NOT EXISTS idx_customers_priority ON customers(priority);
