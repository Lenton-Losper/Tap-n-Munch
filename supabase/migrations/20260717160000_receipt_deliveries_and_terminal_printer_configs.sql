-- Receipt capability Phase 2 (Bluetooth printing): delivery attempt log + per-device
-- printer pairing. Renderer/native-bridge/print-flow work lives outside this migration.

-- ---------------------------------------------------------------------------
-- 1. receipt_deliveries (append-only delivery attempt log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.receipt_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_document_id uuid NOT NULL REFERENCES public.receipt_documents(id),
  -- Only PRINT for this phase; widen the check when EMAIL/LINK land (Phase 3+).
  method text NOT NULL CHECK (method IN ('PRINT')),
  -- Not used for PRINT; present for future EMAIL/LINK phases.
  destination text,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_number int NOT NULL DEFAULT 1,
  provider text,
  provider_reference text,
  device_id text,
  requested_by uuid REFERENCES auth.users(id),
  error_code text,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receipt_deliveries_receipt_document_id_idx
  ON public.receipt_deliveries (receipt_document_id);

CREATE INDEX IF NOT EXISTS receipt_deliveries_status_idx
  ON public.receipt_deliveries (status);

ALTER TABLE public.receipt_deliveries ENABLE ROW LEVEL SECURITY;

-- No update policy -- a retry is a new row (attempt_number incremented), never an edit
-- to a prior attempt. No insert/delete policy or grants either: rows are written
-- exclusively by the service role, same as receipt_documents.
CREATE POLICY "Staff can read receipt deliveries for their restaurant"
  ON public.receipt_deliveries
  FOR SELECT
  TO authenticated
  USING (
    receipt_document_id IN (
      SELECT id FROM public.receipt_documents
      WHERE restaurant_id IN (SELECT public.user_restaurant_ids())
    )
  );

-- ---------------------------------------------------------------------------
-- 2. terminal_printer_configs (device-level pairing, not staff-level data)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.terminal_printer_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matches the terminal identity convention already used elsewhere (e.g.
  -- payment_events.terminal_id): restaurant_terminals.id, the JWT `sub` issued by
  -- requireTerminalAuth() -- not device_id/device_serial/sn.
  terminal_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'CUSTOMER_RECEIPT' CHECK (purpose IN ('CUSTOMER_RECEIPT')),
  connection_type text NOT NULL DEFAULT 'BLUETOOTH' CHECK (connection_type IN ('BLUETOOTH')),
  printer_name text,
  -- Bluetooth MAC address.
  printer_address text,
  paper_width_mm int NOT NULL DEFAULT 80,
  character_width int,
  is_default boolean NOT NULL DEFAULT true,
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS terminal_printer_configs_terminal_id_idx
  ON public.terminal_printer_configs (terminal_id);

ALTER TABLE public.terminal_printer_configs ENABLE ROW LEVEL SECURITY;

-- This table has no restaurant_id column -- it's keyed by terminal_id, device-level
-- data, not staff-level. user_restaurant_ids() can't apply directly, so scope reads by
-- joining through restaurant_terminals (the same join-through-parent shape already used
-- for e.g. goods_received_items, which also has no restaurant_id of its own). Writes are
-- service-role only (the terminal's own authenticated API), same as receipt_documents /
-- receipt_deliveries -- no insert/update/delete policy or grants here.
CREATE POLICY "Staff can read printer configs for their restaurant's terminals"
  ON public.terminal_printer_configs
  FOR SELECT
  TO authenticated
  USING (
    terminal_id IN (
      SELECT id::text FROM public.restaurant_terminals
      WHERE restaurant_id IN (SELECT public.user_restaurant_ids())
    )
  );
