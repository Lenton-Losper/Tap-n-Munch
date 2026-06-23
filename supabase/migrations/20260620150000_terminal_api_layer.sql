-- Terminal API layer: device_serial, status, app_version, terminal_name

ALTER TABLE public.restaurant_terminals
ADD COLUMN IF NOT EXISTS device_serial TEXT,
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'revoked', 'maintenance', 'pending_update')),
ADD COLUMN IF NOT EXISTS app_version TEXT,
ADD COLUMN IF NOT EXISTS terminal_name TEXT;

UPDATE public.restaurant_terminals
SET device_serial = device_id
WHERE device_serial IS NULL AND device_id IS NOT NULL;
