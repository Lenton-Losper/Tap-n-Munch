-- payment_events: replace singular order_id with order_ids uuid[] (Option B).
-- No application code referenced order_id yet; schema-only correction (no data backfill).

DROP INDEX IF EXISTS public.payment_events_order_id_idx;

ALTER TABLE public.payment_events
  DROP COLUMN order_id;

ALTER TABLE public.payment_events
  ADD COLUMN order_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.payment_events
  ALTER COLUMN order_ids DROP DEFAULT;

ALTER TABLE public.payment_events
  ADD CONSTRAINT payment_events_order_ids_not_empty
  CHECK (array_length(order_ids, 1) > 0);

-- Single-order SALE/refund: order_ids = ARRAY[the one order id].
-- Tab settlement: order_ids = full set of orders covered by that payment.
-- One representation for "which orders does this event relate to", regardless of count.

CREATE INDEX IF NOT EXISTS payment_events_order_ids_gin_idx
  ON public.payment_events USING GIN (order_ids);
