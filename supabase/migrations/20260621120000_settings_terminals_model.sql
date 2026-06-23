-- Settings terminals: device model + optional activation code for manual registration
-- Uses existing restaurant_terminals (maps to spec: label=name, serial_number=sn, device_model=model, is_active=active)

ALTER TABLE public.restaurant_terminals
  ADD COLUMN IF NOT EXISTS model text;

ALTER TABLE public.restaurant_terminals
  ALTER COLUMN activation_code DROP NOT NULL;

ALTER TABLE public.restaurant_terminals
  ALTER COLUMN expires_at DROP NOT NULL;
