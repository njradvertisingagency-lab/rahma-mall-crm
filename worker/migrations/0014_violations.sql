PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_violations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reported_by       INTEGER REFERENCES users(id),
  violation_type    TEXT NOT NULL CHECK (violation_type IN ('LATE','ABSENCE','MISCONDUCT','POLICY_BREACH','PERFORMANCE','OTHER')),
  severity          TEXT NOT NULL CHECK (severity IN ('MINOR','MODERATE','SEVERE')),
  occurred_at       TEXT NOT NULL,
  description       TEXT NOT NULL,
  action_taken      TEXT NOT NULL DEFAULT 'NONE' CHECK (action_taken IN ('NONE','VERBAL_WARNING','WRITTEN_WARNING','SUSPENSION','FINE','TERMINATION_NOTICE')),
  action_note       TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  employee_comment  TEXT,
  acknowledged_at   TEXT,
  resolved_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_violations_employee ON employee_violations(employee_id);
CREATE INDEX IF NOT EXISTS idx_violations_status ON employee_violations(status);
