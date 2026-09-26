PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_evaluations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  evaluator_id          INTEGER REFERENCES users(id),
  period                TEXT NOT NULL,
  quality_score         INTEGER NOT NULL CHECK (quality_score BETWEEN 1 AND 5),
  punctuality_score     INTEGER NOT NULL CHECK (punctuality_score BETWEEN 1 AND 5),
  teamwork_score        INTEGER NOT NULL CHECK (teamwork_score BETWEEN 1 AND 5),
  communication_score   INTEGER NOT NULL CHECK (communication_score BETWEEN 1 AND 5),
  sales_score           INTEGER NOT NULL CHECK (sales_score BETWEEN 1 AND 5),
  overall_score         REAL NOT NULL,
  strengths             TEXT,
  improvements          TEXT,
  status                TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACKNOWLEDGED')),
  employee_comment      TEXT,
  acknowledged_at       TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evals_employee ON employee_evaluations(employee_id);
CREATE INDEX IF NOT EXISTS idx_evals_period ON employee_evaluations(period);
