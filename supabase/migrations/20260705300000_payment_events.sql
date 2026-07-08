-- Payment events ledger (Phase 1: refund events only).
-- SALE events remain on orders until Phase 2.

-- ---------------------------------------------------------------------------
-- 1. payment_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  -- NOTE (bridge architecture, Phase 3 roadmap): this table is scoped to refund events only
  -- in Phase 1. order_id references the order directly for now. Once a first-class Payment
  -- entity exists (Phase 3), this will become payment_id -> orders via the Payment record,
  -- not a direct order_id here. Do not treat this FK as permanent.
  event_type text NOT NULL CHECK (event_type IN ('refund_attempted', 'refund_succeeded', 'refund_failed')),
  business_order_no text NOT NULL,
  origin_business_order_no text NOT NULL,
  transaction_id text,
  terminal_id text,
  app_version text,
  amount numeric NOT NULL,
  CONSTRAINT payment_events_amount_positive CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'NAD',
  idempotency_key text NOT NULL,
  initiated_by uuid NOT NULL REFERENCES public.users(id),
  reason_code text NOT NULL,
  reason_note text,
  gateway_result_code text,
  gateway_result_message text,
  raw_gateway_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, idempotency_key)
);

-- IMPORTANT (not yet a complete ledger): this table only records refund events in Phase 1.
-- SALE events are NOT recorded here yet -- they remain on orders. A query against
-- payment_events alone will show refund activity but MISS every sale until Phase 2 adds
-- SALE event recording. Do not assume this table represents complete payment history.

CREATE INDEX IF NOT EXISTS payment_events_restaurant_id_idx
  ON public.payment_events (restaurant_id);

CREATE INDEX IF NOT EXISTS payment_events_order_id_idx
  ON public.payment_events (order_id);

-- ---------------------------------------------------------------------------
-- 2. payments:read / payments:refund on owner / manager roles
-- ---------------------------------------------------------------------------
UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'payments:read')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('payments:read' = ANY (permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'payments:refund')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('payments:refund' = ANY (permissions));

-- ---------------------------------------------------------------------------
-- 3. RLS (read: payments:read via user_has_permission; write: service role only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authorized staff can read payment events"
  ON public.payment_events
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'payments:read'));
