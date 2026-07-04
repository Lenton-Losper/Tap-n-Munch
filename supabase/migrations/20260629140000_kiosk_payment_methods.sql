-- Add kiosk-specific payment method configuration to restaurant_settings.
-- Kept as a dedicated column (not JSONB) for MVP; future kiosk settings
-- will be consolidated into kiosk_settings jsonb when requirements grow.
-- Default preserves existing kiosk behaviour for all restaurants.

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS kiosk_payment_methods text[]
  DEFAULT ARRAY['cash', 'card', 'other']::text[]
  NOT NULL;

-- Extend the payment method check constraint to cover kiosk methods.
-- 'other' is a valid kiosk payment method and must be validated server-side.
ALTER TABLE restaurant_settings
  DROP CONSTRAINT IF EXISTS valid_kiosk_payment_methods;

ALTER TABLE restaurant_settings
  ADD CONSTRAINT valid_kiosk_payment_methods CHECK (
    kiosk_payment_methods <@ ARRAY['cash', 'card', 'other']::text[]
  );
