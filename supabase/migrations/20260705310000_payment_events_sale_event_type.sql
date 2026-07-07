-- Expand payment_events.event_type to allow immutable SALE gateway reference capture (Phase 1).

ALTER TABLE public.payment_events
  DROP CONSTRAINT payment_events_event_type_check;

ALTER TABLE public.payment_events
  ADD CONSTRAINT payment_events_event_type_check
  CHECK (event_type IN ('sale', 'refund_attempted', 'refund_succeeded', 'refund_failed'));

-- Update the earlier bridge-architecture comment: this table now captures the immutable SALE
-- gateway reference as part of Phase 1 ("Refund Foundation"), not as a Phase 2 addition.
-- Phase 1 = capture SALE gateway reference + record refund attempts/outcomes + idempotency +
-- audit trail. Phase 2 = complete financial event recording (full SALE history, reporting,
-- ledger completeness) -- NOT the same thing as this SALE reference capture.
-- A query against payment_events still does not represent complete transaction history until
-- Phase 2: today it only contains one 'sale' row per order (the gateway reference) and refund
-- events, not full settlement/reconciliation detail.
