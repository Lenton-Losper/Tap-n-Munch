-- restaurant_terminals AS PRODUCTION DEFINES IT (read from ihlmmpmolnpchzgwyhgh on 2026-09-30:
-- information_schema.columns, pg_constraint, pg_indexes). fixture-schema.sql does not carry this
-- table; the device-transfer suite needs its REAL constraints -- above all the two global unique
-- indexes -- because "two rows can never claim one device" is enforced by them, not by the function.
CREATE TABLE IF NOT EXISTS public.restaurant_terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  device_id text,
  sn text,
  name text,
  model text,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  activation_code text,
  activation_code_expires_at timestamptz,
  activated_at timestamptz,
  device_serial text,
  status text NOT NULL DEFAULT 'active',
  app_version text,
  terminal_name text,
  refresh_token_hash text,
  refresh_token_expires_at timestamptz,
  expires_at timestamptz,
  station_kind text,
  CONSTRAINT restaurant_terminals_device_id_unique UNIQUE (device_id),
  CONSTRAINT restaurant_terminals_device_serial_unique UNIQUE (device_serial),
  CONSTRAINT restaurant_terminals_station_kind_check CHECK (station_kind = ANY (ARRAY['kitchen'::text, 'bar'::text])),
  CONSTRAINT restaurant_terminals_status_check CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'revoked'::text, 'pending'::text]))
);
