-- RAHMA MALL — FEATURE BATCH (Sep 2026)
-- Adds: VIP customer flag, complaints log, internal Team-Leader<->employee
-- chat, per-user favorite customers, daily performance snapshots (for
-- performance-over-time charts), temporary "Do Not Disturb" for employees,
-- and a dedicated dedup/audit log for the "customer waiting for you" alert
-- (kept separate from sla_events so its existing CHECK(rule IN (...))
-- constraint never needs to be touched on a live production table).

PRAGMA foreign_keys = ON;

-- =====================================================================
-- VIP CUSTOMER FLAG
-- =====================================================================
ALTER TABLE customers ADD COLUMN is_vip INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_customers_vip ON customers(is_vip);

-- =====================================================================
-- COMPLAINTS LOG (distinct from a regular customer_notes entry, so
-- complaint rate per employee can be tracked on its own)
-- =====================================================================
CREATE TABLE IF NOT EXISTS complaints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id),
  created_by    INTEGER REFERENCES users(id),
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_complaints_customer ON complaints(customer_id);
CREATE INDEX IF NOT EXISTS idx_complaints_employee ON complaints(employee_id);
CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at);

-- =====================================================================
-- INTERNAL CHAT (one thread per employee, between that employee and the
-- Team Leader — there is only ever one Team Leader in this system)
-- =====================================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sender_role    TEXT NOT NULL CHECK (sender_role IN ('team_leader','employee')),
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_name    TEXT,
  message        TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_employee ON chat_messages(employee_id, created_at);

CREATE TABLE IF NOT EXISTS chat_reads (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  last_read_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, employee_id)
);

-- =====================================================================
-- FAVORITES ("My Favorites" — per user, so each employee / the Team
-- Leader can each keep their own quick-access shortlist)
-- =====================================================================
CREATE TABLE IF NOT EXISTS favorites (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_customer ON favorites(customer_id);

-- =====================================================================
-- PERFORMANCE SNAPSHOTS (one row per employee per calendar day; the
-- current day's row is upserted on every cron tick so "today" always
-- reflects live numbers, while past days are frozen history — this is
-- what powers the performance-over-time chart. The live /employees
-- endpoint remains the source of truth for "right now"; this table only
-- ever adds a historical trail alongside it.)
-- =====================================================================
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  snapshot_date         TEXT NOT NULL,   -- 'YYYY-MM-DD'
  score                 INTEGER NOT NULL,
  completion_rate       REAL NOT NULL,
  closed                INTEGER NOT NULL,
  assigned              INTEGER NOT NULL DEFAULT 0,
  followups_completed   INTEGER NOT NULL,
  followups_overdue     INTEGER NOT NULL,
  avg_response_minutes  REAL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(employee_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_perfsnap_employee_date ON performance_snapshots(employee_id, snapshot_date);

-- =====================================================================
-- TEMPORARY "DO NOT DISTURB" — layered on top of the existing manual
-- availability field. When dnd_until is set and availability is
-- UNAVAILABLE, the UI shows it as a *temporary* DND (with a countdown)
-- rather than a plain permanent "unavailable", and the cron sweep
-- reverts availability back to AVAILABLE automatically once it passes.
-- =====================================================================
ALTER TABLE employees ADD COLUMN dnd_until TEXT;

-- =====================================================================
-- "CUSTOMER WAITING FOR YOU" — dedup/audit log, mirroring sla_events'
-- shape exactly but kept as its own table (see header note above).
-- =====================================================================
CREATE TABLE IF NOT EXISTS waiting_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id),
  level         TEXT NOT NULL CHECK (level IN ('WARNING','BREACHED')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_waitingevents_customer ON waiting_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_waitingevents_unresolved ON waiting_events(customer_id, resolved_at);
