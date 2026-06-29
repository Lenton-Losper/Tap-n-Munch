-- Extend public_restaurant_settings view to include kiosk_payment_methods.
-- Rule: any restaurant configuration safe for anonymous customers to read
-- must be exposed through this view. Administrative APIs are for settings
-- that require authentication or contain sensitive information.
DROP VIEW IF EXISTS public.public_restaurant_settings;

CREATE VIEW public.public_restaurant_settings AS
SELECT
  restaurant_id,
  currency,
  payment_methods,
  kiosk_payment_methods,
  tab_pin_required,
  max_tab_hours
FROM public.restaurant_settings;
