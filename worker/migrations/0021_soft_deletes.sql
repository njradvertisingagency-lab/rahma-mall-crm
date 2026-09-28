PRAGMA foreign_keys = ON;

-- =====================================================================
-- SOFT DELETES — generic "this row is deleted" marker table, used instead
-- of `DELETE FROM ...` for business records the company must never lose
-- permanently (complaints, HR employee documents/contracts, internal
-- announcements). We can't add a `deleted_at` column directly to those
-- existing tables (`ALTER TABLE` is blocked by this project's D1
-- permission classifier — only CREATE TABLE/CREATE INDEX are allowed), so
-- a companion table plays the same role: a row present here means the
-- (entity_type, entity_id) pair is "deleted" from every normal listing,
-- while the original row stays fully intact and recoverable in its real
-- table for as long as the business needs it.
--
-- "Deleting" a complaint/document/announcement now means INSERT INTO
-- soft_deletes instead of DELETE FROM the real table; every SELECT that
-- lists these rows excludes ones present here (LEFT JOIN ... WHERE
-- sd.entity_id IS NULL). Restoring one later is a one-row DELETE FROM
-- soft_deletes — no data was ever destroyed.
-- =====================================================================
CREATE TABLE IF NOT EXISTS soft_deletes (
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER NOT NULL,
  deleted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_by   INTEGER REFERENCES users(id),
  PRIMARY KEY (entity_type, entity_id)
);
