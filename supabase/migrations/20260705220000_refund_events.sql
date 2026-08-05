-- Recovered 2026-08-05 from the staging migration ledger (issue #143). Applied to staging ad hoc
-- and never committed. Reconstructed verbatim from the ledger. NOT yet applied to production.

-- Post-Payment Order Lifecycle ADR: append-only refund ledger.
-- Net refunded amount is enforced in the API layer (Prompt 3), not here.

CREATE TABLE IF NOT EXISTS refund_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id       uuid NOT NULL REFERENCES payments(id),
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  reason           text,
  refunded_by      uuid NOT NULL REFERENCES staff_members(id),
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_events_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refund_events_order_id ON refund_events(order_id);

CREATE INDEX IF NOT EXISTS idx_refund_events_payment_id ON refund_events(payment_id);

ALTER TABLE refund_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_view_refund_events ON refund_events
  FOR SELECT USING (restaurant_id IN (SELECT user_restaurant_ids()));

CREATE POLICY staff_insert_refund_events ON refund_events
  FOR INSERT WITH CHECK (restaurant_id IN (SELECT user_restaurant_ids()));
