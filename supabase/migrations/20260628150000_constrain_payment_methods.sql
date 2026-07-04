-- Constrain payment_methods to known valid values
ALTER TABLE restaurant_settings
  DROP CONSTRAINT IF EXISTS payment_methods_valid_values;

ALTER TABLE restaurant_settings
  ADD CONSTRAINT payment_methods_valid_values CHECK (
    payment_methods <@ ARRAY['cash', 'card', 'hosted_checkout', 'eft', 'voucher', 'mobile_money']::text[]
  );
