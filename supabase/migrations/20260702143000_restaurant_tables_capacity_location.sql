-- Ordering Points: optional seats and location per table/kiosk row
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS capacity integer,
  ADD COLUMN IF NOT EXISTS location text;
