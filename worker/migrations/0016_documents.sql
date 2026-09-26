PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('CONTRACT','ID_COPY','CERTIFICATE','CV','OTHER')),
  title         TEXT NOT NULL,
  external_url  TEXT,
  issue_date    TEXT,
  expiry_date   TEXT,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_employee ON employee_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON employee_documents(expiry_date);
