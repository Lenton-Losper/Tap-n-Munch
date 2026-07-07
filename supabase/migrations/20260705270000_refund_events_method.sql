-- Refund paths: card (gateway-backed) vs cash (ledger-only).

ALTER TABLE public.refund_events
  ADD COLUMN IF NOT EXISTS refund_method text NOT NULL DEFAULT 'cash';

ALTER TABLE public.refund_events DROP CONSTRAINT IF EXISTS refund_events_refund_method_check;
ALTER TABLE public.refund_events
  ADD CONSTRAINT refund_events_refund_method_check
  CHECK (refund_method IN ('card', 'cash'));

ALTER TABLE public.refund_events
  ADD COLUMN IF NOT EXISTS gateway_reference text;

ALTER TABLE public.refund_events DROP CONSTRAINT IF EXISTS refund_events_gateway_reference_check;
ALTER TABLE public.refund_events
  ADD CONSTRAINT refund_events_gateway_reference_check
  CHECK (
    (refund_method = 'card' AND gateway_reference IS NOT NULL) OR
    (refund_method = 'cash' AND gateway_reference IS NULL)
  );
