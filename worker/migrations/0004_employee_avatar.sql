-- Adds an optional profile photo for employees, stored as a compressed
-- data: URL (small square JPEG, resized client-side before upload) rather
-- than a separate object-storage bucket, keeping this a pure D1 change with
-- no new infrastructure. NULL means "no photo" — the UI falls back to the
-- existing initials avatar.
ALTER TABLE employees ADD COLUMN avatar_data_url TEXT;
