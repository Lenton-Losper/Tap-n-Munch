-- Receipt capability Phase 3 prep: widen two check constraints ahead of the email delivery
-- adapter (this repo) and the P5 built-in-printer selector (terminal-repo task).

-- ---------------------------------------------------------------------------
-- 1. terminal_printer_configs.connection_type: allow 'BUILTIN' alongside 'BLUETOOTH'.
-- Lets staff pick the P5's own built-in printer instead of a paired Bluetooth one.
-- ---------------------------------------------------------------------------
ALTER TABLE public.terminal_printer_configs
  DROP CONSTRAINT IF EXISTS terminal_printer_configs_connection_type_check;

ALTER TABLE public.terminal_printer_configs
  ADD CONSTRAINT terminal_printer_configs_connection_type_check
  CHECK (connection_type IN ('BLUETOOTH', 'BUILTIN'));

-- ---------------------------------------------------------------------------
-- 2. receipt_deliveries.method: allow 'EMAIL' alongside 'PRINT'.
-- ---------------------------------------------------------------------------
ALTER TABLE public.receipt_deliveries
  DROP CONSTRAINT IF EXISTS receipt_deliveries_method_check;

ALTER TABLE public.receipt_deliveries
  ADD CONSTRAINT receipt_deliveries_method_check
  CHECK (method IN ('PRINT', 'EMAIL'));

-- receipt_deliveries.provider is free-text (no check constraint) -- 'wiseasy_sdk6' is a
-- valid future value for PRINT (P5 built-in SDK) alongside 'bluetooth_escpos', same as
-- 'resend' is expected for EMAIL. No schema change needed for this column.
COMMENT ON COLUMN public.receipt_deliveries.provider IS
  'Free-text delivery provider, e.g. bluetooth_escpos, wiseasy_sdk6 (P5 built-in printer), resend (email).';
