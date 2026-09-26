PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_benefits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  benefit_type   TEXT NOT NULL CHECK (benefit_type IN ('BONUS','ALLOWANCE','DEDUCTION','ADVANCE','OTHER')),
  amount         REAL NOT NULL,
  description    TEXT,
  effective_date TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','PAID','REJECTED')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_benefits_employee ON employee_benefits(employee_id);
CREATE INDEX IF NOT EXISTS idx_benefits_status ON employee_benefits(status);
