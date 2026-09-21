-- Adds an `is_owner` flag on top of the existing role system. An owner
-- account still has role='team_leader' (so it automatically inherits every
-- existing team_leader permission/visibility with zero authorization
-- changes elsewhere) — this flag only unlocks the extra "Team Leader
-- performance/activity" oversight view meant for the business owner.
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
