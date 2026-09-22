-- Adds automation support for: (1) late-attendance alerts — a per-employee
-- dedup date so the alert fires once per day, not once per cron minute —
-- and (2) automatic Do-Not-Disturb outside declared work hours, which
-- remembers the employee's availability from just before switching them
-- off so it can be restored exactly, not just reset to AVAILABLE.
--
-- The two admin-only ops reports (start-of-day / end-of-shift) need no
-- schema changes of their own: they are computed live from existing tables
-- and use the generic `settings` key/value table (already in 0001_init.sql)
-- for their once-a-day dedupe and shared work-hours config.

ALTER TABLE employees ADD COLUMN last_late_alert_date TEXT;
ALTER TABLE employees ADD COLUMN off_hours_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN pre_off_hours_availability TEXT;
