-- @env: staging
--
-- SCOPED TO STAGING, 2026-08-25. Applied on staging, absent on production -- verified:
--
--     STAGING     refund_events EXISTS, ledger has 20260705220000
--     PRODUCTION  refund_events ABSENT, ledger does not
--
-- The header states where it IS, which is what the drift checker needs. Without one it defaults to
-- `both`, so production reported it as missing and the 2026-08-24 promotion had to exclude it by
-- hand alongside 20260705210000.
--
-- NOT a #170-style collision -- there is no competing definition of refund_events. This is simply
-- staging-only work: the post-payment lifecycle ADR that 20260705210000 belongs to. If that ADR
-- ships, this file goes to production WITH it and the scope is removed deliberately. It cannot go
-- alone: it takes a NOT NULL FK to payments(id), and production's `payments` does not carry the
-- shape this expects -- a dependency check on 2026-08-25 found `payments.order_id does not exist`
-- there.

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
