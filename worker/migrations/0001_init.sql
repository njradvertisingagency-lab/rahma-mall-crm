-- RAHMA MALL — Live Call Team CRM
-- Initial D1 schema. Applied with: wrangler d1 migrations apply rahma_mall_db

PRAGMA foreign_keys = ON;

-- =====================================================================
-- AUTH
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,           -- hex digest
  password_salt TEXT NOT NULL,           -- hex salt, unique per user
  role          TEXT NOT NULL CHECK (role IN ('team_leader','employee')),
  display_name  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_ar       TEXT,                     -- Arabic display name, stored explicitly (never auto-translated)
  avatar_initial TEXT NOT NULL,
  availability  TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (availability IN ('AVAILABLE','BUSY','ON_BREAK','UNAVAILABLE')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_availability ON employees(availability);

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- =====================================================================
-- ID / SEQUENCE COUNTERS (atomic via UPDATE ... RETURNING)
-- =====================================================================
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('customer_seq', 0);
INSERT OR IGNORE INTO counters (name, value) VALUES ('distribution_seq', 0);

-- =====================================================================
-- CUSTOMERS
-- =====================================================================
CREATE TABLE IF NOT EXISTS customers (
  id                  TEXT PRIMARY KEY,          -- RM-000001
  phone               TEXT NOT NULL,             -- original input, preserved
  normalized_phone    TEXT NOT NULL,             -- 01XXXXXXXXX canonical form
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'NEW'
                        CHECK (status IN ('NEW','CALLING','NO_ANSWER','BUSY','FOLLOW_UP','INTERESTED','NOT_INTERESTED','CLOSED')),
  priority            TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  assigned_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  source              TEXT,
  campaign            TEXT,
  product             TEXT,
  archived            INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  assigned_at         TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  next_follow_up_at   TEXT,
  closed_at           TEXT,
  closed_reason       TEXT,
  closed_by           INTEGER REFERENCES users(id),
  version             INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  whatsapp_contact_status TEXT NOT NULL DEFAULT 'NOT_CONTACTED'
    CHECK (whatsapp_contact_status IN ('NOT_CONTACTED','CONTACT_INITIATED','SENT','DELIVERED','READ','FAILED')),
  whatsapp_contacted_at  TEXT,
  whatsapp_contacted_by  INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_normalized_phone ON customers(normalized_phone) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_assigned ON customers(assigned_employee_id);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_nextfollowup ON customers(next_follow_up_at);
CREATE INDEX IF NOT EXISTS idx_customers_archived ON customers(archived);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp_status ON customers(whatsapp_contact_status);

-- =====================================================================
-- WHATSAPP INTERACTIONS (append-only log; never overwritten)
-- =====================================================================
CREATE TABLE IF NOT EXISTS whatsapp_interactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id),
  initiated_by  INTEGER REFERENCES users(id),
  phone         TEXT NOT NULL,
  message       TEXT NOT NULL,
  -- CONTACT_INITIATED is the only status this build ever sets on its own —
  -- it means "the employee opened WhatsApp with a prepared message", NOT
  -- that WhatsApp confirmed sending/delivery/read (we have no such signal
  -- without WhatsApp Business API). SENT/DELIVERED/READ/FAILED are reserved
  -- for a future WhatsApp Business API integration (see lib/whatsapp.js).
  status        TEXT NOT NULL DEFAULT 'CONTACT_INITIATED'
    CHECK (status IN ('CONTACT_INITIATED','SENT','DELIVERED','READ','FAILED')),
  initiated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at       TEXT,
  delivered_at  TEXT,
  read_at       TEXT,
  failed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_customer ON whatsapp_interactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_employee ON whatsapp_interactions(employee_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_created ON whatsapp_interactions(created_at);

-- =====================================================================
-- ASSIGNMENT HISTORY (never overwritten)
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id    INTEGER REFERENCES employees(id),   -- NULL = unassigned
  assigned_by    INTEGER REFERENCES users(id),
  assigned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason         TEXT NOT NULL DEFAULT 'DISTRIBUTION' CHECK (reason IN ('DISTRIBUTION','MANUAL','REASSIGNMENT','IMPORT_UNASSIGNED')),
  distribution_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assignments_customer ON customer_assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_assignments_employee ON customer_assignments(employee_id);

-- =====================================================================
-- STATUS HISTORY (never overwritten)
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  changed_by   INTEGER REFERENCES users(id),
  changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_statushist_customer ON customer_status_history(customer_id);

-- =====================================================================
-- NOTES (append-only)
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  author_id    INTEGER REFERENCES users(id),
  author_name  TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_customer ON customer_notes(customer_id);

-- =====================================================================
-- FOLLOW-UPS
-- =====================================================================
CREATE TABLE IF NOT EXISTS followups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  employee_id    INTEGER REFERENCES employees(id),
  scheduled_for  TEXT NOT NULL,
  reason         TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'UPCOMING' CHECK (status IN ('UPCOMING','DUE','COMPLETED','OVERDUE','CANCELLED')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at   TEXT,
  completed_by   INTEGER REFERENCES users(id),
  cancelled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups(customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_employee ON followups(employee_id);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled ON followups(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);

-- =====================================================================
-- ACTIVITY LOG (immutable audit trail)
-- =====================================================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER REFERENCES users(id),
  actor_name   TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  metadata     TEXT,             -- JSON string
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_logs(actor_id);

-- =====================================================================
-- NOTIFICATIONS
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  read         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

-- =====================================================================
-- DISTRIBUTIONS
-- =====================================================================
CREATE TABLE IF NOT EXISTS distributions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,           -- "Distribution #001"
  method          TEXT NOT NULL CHECK (method IN ('EQUAL','ROUND_ROBIN','MANUAL')),
  total_customers INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS distribution_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id INTEGER NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_distitems_dist ON distribution_items(distribution_id);
CREATE INDEX IF NOT EXISTS idx_distitems_employee ON distribution_items(employee_id);

-- =====================================================================
-- SETTINGS (singleton key/value, JSON values)
-- =====================================================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,   -- JSON
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  INTEGER REFERENCES users(id)
);
