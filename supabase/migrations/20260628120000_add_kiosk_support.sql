-- Add kiosk flag to restaurant_tables
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS is_kiosk BOOLEAN NOT NULL DEFAULT false;

-- Add customer_name to tabs for kiosk orders
ALTER TABLE tabs
  ADD COLUMN IF NOT EXISTS customer_name TEXT;

-- Add index for kiosk table lookups
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_kiosk
  ON restaurant_tables (restaurant_id, is_kiosk)
  WHERE is_kiosk = true;
