PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_trainings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  training_type     TEXT NOT NULL CHECK (training_type IN ('COURSE','WORKSHOP','CERTIFICATION','ONLINE','OTHER')),
  provider          TEXT,
  start_date        TEXT,
  end_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  certificate_note  TEXT,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_trainings_employee ON employee_trainings(employee_id);
CREATE INDEX IF NOT EXISTS idx_trainings_status ON employee_trainings(status);
