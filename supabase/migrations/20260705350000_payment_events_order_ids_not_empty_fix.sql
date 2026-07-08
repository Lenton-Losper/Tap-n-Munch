-- payment_events: fix order_ids NOT EMPTY constraint (array_length vs cardinality).

ALTER TABLE public.payment_events
  DROP CONSTRAINT payment_events_order_ids_not_empty;

ALTER TABLE public.payment_events
  ADD CONSTRAINT payment_events_order_ids_not_empty
  CHECK (cardinality(order_ids) > 0);

-- Fixes a bug in the prior version of this constraint: array_length(order_ids, 1) returns NULL
-- (not 0) for an empty array, and CHECK constraints only reject explicit FALSE -- NULL passes.
-- cardinality() correctly returns 0 for an empty array, so this version actually rejects
-- empty order_ids as intended.
