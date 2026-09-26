-- A dedicated check-in/check-out attendance system — deliberately SEPARATE
-- from login/logout (employees.js /auth) and from the automatic presence
-- system (employee_presence/employee_sessions in 0002_master_upgrade.sql).
-- Login/logout and presence track "is this browser tab open and active
-- right now"; this tracks "did the person physically clock themselves in
-- and out today" — a real, explicit action, one row per person per day.
-- Applies to EVERY account (employee, team leader, owner) via users.id, not
-- just employees — the Team Leader is meant to see and use this too.
CREATE TABLE IF NOT EXISTS attendance_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date     TEXT NOT NULL,   -- YYYY-MM-DD, Cairo calendar day this row belongs to
  check_in_at   TEXT,
  check_out_at  TEXT,
  is_late       INTEGER NOT NULL DEFAULT 0,  -- 1 only for a real work day, checked in after the grace cutoff
  late_minutes  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance_records(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(work_date);

-- One row per late check-in beyond the monthly allowance (3 — see
-- lib/attendance.js). Kept as a permanent, queryable record — not just a
-- transient notification — so Mr. Hany's dashboard always shows an
-- accurate running penalty count per employee per month.
CREATE TABLE IF NOT EXISTS attendance_penalties (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_record_id  INTEGER REFERENCES attendance_records(id) ON DELETE SET NULL,
  month                 TEXT NOT NULL,  -- YYYY-MM
  late_count_at_penalty INTEGER NOT NULL,  -- e.g. 4, 5, 6... (allowance is 3/month)
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_penalties_user ON attendance_penalties(user_id);
CREATE INDEX IF NOT EXISTS idx_penalties_month ON attendance_penalties(month);
