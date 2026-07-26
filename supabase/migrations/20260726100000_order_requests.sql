-- Order Request / Accept model (table + kiosk channels only, staging rollout).
-- A row here is NOT a real order -- nothing downstream (kitchen routing, payment,
-- stock deduction, tab totals) should ever read this table. It only becomes a real
-- order when staff Accept creates a row in `orders` and sets accepted_order_id here.
-- Terminal/POS is explicitly out of scope and continues inserting into `orders` directly.

CREATE TABLE IF NOT EXISTS public.order_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  firebase_restaurant_id text,
  channel text NOT NULL CHECK (channel IN ('table', 'kiosk')),
  table_number integer NOT NULL DEFAULT 0,
  table_id uuid,
  session_id text,
  member_session_id text,
  customer_name text,
  order_instructions text,

  -- As submitted by the customer. Never mutated after insert (audit trail).
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  tax numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,

  -- Staff edits during review. Null until touched. Recalculated via
  -- calculateOrderPricing, same as the original -- never hand-entered totals.
  items_reviewed jsonb,
  subtotal_reviewed numeric,
  tax_reviewed numeric,
  total_reviewed numeric,

  payment_method text,
  payment_channel text,
  tab_id uuid,
  tab_settlement_for_tab_id uuid,
  idempotency_key text,

  status text NOT NULL DEFAULT 'waiting_review'
    CHECK (status IN ('waiting_review', 'accepted', 'declined')),
  accepted_order_id uuid REFERENCES public.orders(id),
  declined_reason text,

  placed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.users(id),

  CONSTRAINT order_requests_accepted_has_order
    CHECK (status <> 'accepted' OR accepted_order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS order_requests_restaurant_id_idx
  ON public.order_requests (restaurant_id);

CREATE INDEX IF NOT EXISTS order_requests_status_idx
  ON public.order_requests (restaurant_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS order_requests_idempotency_key_idx
  ON public.order_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: staff read/update their restaurant's requests via user_restaurant_ids()
-- (same helper used by orders RLS). Guest submission + guest status reads go
-- through service-role API routes, same pattern as `orders` -- no anon grants.
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read order requests for their restaurants"
  ON public.order_requests
  FOR SELECT
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

CREATE POLICY "Staff can update order requests for their restaurants"
  ON public.order_requests
  FOR UPDATE
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.user_restaurant_ids()));
