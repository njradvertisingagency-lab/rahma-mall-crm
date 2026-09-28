PRAGMA foreign_keys = ON;

-- =====================================================================
-- DIRECT MESSAGES (person-to-person) — replaces the old "employee <->
-- the Team Leader" single-thread chat (chat_messages/chat_reads, kept in
-- place untouched for history — never deleted) with a general user-to-user
-- model: any active account (employee, Team Leader, HR, the owner) can
-- message any other active account directly, and only the two participants
-- can see a given conversation — except HR and the owner, who can see every
-- conversation in the system for oversight (per explicit request).
--
-- Old chat_messages rows aren't migrated in here: each old row only ever
-- recorded "an employee" or "the team leader" as sender, never a specific
-- recipient user id (there was only ever one real recipient side to infer),
-- so guessing a recipient_id for historical rows would risk misattributing
-- old conversations. That history stays queryable in chat_messages/
-- chat_reads; new conversations start fresh here.
-- =====================================================================
CREATE TABLE IF NOT EXISTS dm_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id),
  recipient_id  INTEGER NOT NULL REFERENCES users(id),
  message       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON dm_messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_messages(recipient_id, sender_id, created_at);

CREATE TABLE IF NOT EXISTS dm_reads (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, other_user_id)
);
