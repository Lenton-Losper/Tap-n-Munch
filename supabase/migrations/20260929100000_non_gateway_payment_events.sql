-- @env: both
--
-- THE NON-GATEWAY PAYMENT LEDGER (Sprint 2026-09-29 brief, F-MANUAL task 1).
--
-- ==================================================================================================
-- THE INVARIANT, AND THE RULING IT REVERSES
-- ==================================================================================================
--
-- Owner's invariant, Sprint 2026-09-29 brief: EVERY SUCCESSFUL PAYMENT MUST HAVE AN IMMUTABLE
-- FINANCIAL LEDGER RECORD.
--
-- Until now only GATEWAY payments had one (`payment_events`, event_type 'sale'). A payment FlashTap
-- did not see a gateway confirm -- a staff member's Mark-as-Paid on the dashboard, cash or PayToday
-- taken on the terminal -- left an `orders` flip, a best-effort `payments` row (which the code
-- DELETED again on its own undo path) and an audit row. The recorded ruling (tab settle route "F2",
-- lib/payments/mark-order-paid-manually.ts) was that such a payment gets NO ledger row, because
-- `payment_events` is the gateway ledger and a cash row there "can never be matched to anything --
-- worse than an absence, because it looks reconciled". The Sprint 2026-09-29 brief overrules the
-- "no ledger row" half and KEEPS the reasoning behind it: a manual payment must not be represented
-- as a gateway payment, and the meaning of gateway rows must not change.
--
-- ==================================================================================================
-- WHY A SEPARATE TABLE, NOT AN `origin` COLUMN ON payment_events
-- ==================================================================================================
--
-- Enumerated 2026-09-29, every application reader of payment_events and what it assumes:
--
--   lib/receipts/issueReceipt.ts:520                 sale rows -> receipt payment lines, masked
--                                                    gateway reference printed per row
--   lib/documents/create-invoice-from-order.ts:470   sale rows -> invoice payment identity
--   lib/payments/get-payment-projection.ts:146,195   sale + refund_succeeded -> refundable balance
--   lib/payments/reconciliation.ts (via cron)        a sale row = "the gateway ledger has it"
--   lib/payments/report-card-payments-without-sale-row.ts:102   presence of ANY sale row per order
--   lib/payments/detect-duplicate-charges.ts:76      two sale rows on one order = double CHARGE
--   lib/payments/resolve-order-by-merchant-order.ts:135   business_order_no -> order (webhook)
--   lib/payments/reconcile-orphan-payments.ts:73     sale rows vs Finatic
--   app/api/terminal/payment-events/sale|refund      the device's writers, keyed on the gateway no.
--   app/api/platform/payments/*, platform/terminals  platform console, gateway rows
--   lib/reports/get-report-data.ts, revenue-timing   refunds + sale derivations
--
-- EVERY ONE of them reads a sale row as "a gateway transaction happened". An origin column would
-- need every one of them to filter on it, now and forever, and the first reader that forgot would
-- print a cash payment with a masked "card reference", report a cash + card order as a duplicate
-- charge, or clear a card order from the missing-sale-row report because a cash row exists. The
-- NOT NULL gateway columns (business_order_no, origin_business_order_no) would also have to be
-- relaxed, changing the table's meaning for every existing row. A separate table keeps every
-- existing reader correct BY CONSTRUCTION: none of them can see these rows.
--
-- The two ledgers together are the complete record: gateway payments in payment_events, every
-- other payment here. There is NO gateway field on this table at all -- nothing here can be
-- mistaken for, or falsely populated as, a gateway artefact.
--
-- ==================================================================================================
-- WHAT A ROW IS
-- ==================================================================================================
--
-- One row per SUCCESSFUL non-gateway collection EVENT (not per order): the Mark-as-Paid of one
-- order, one cash / PayToday tab settlement over N orders, one cash item-split settlement. The
-- per-allocation breakdown of a split stays in order_line_allocation_settlements, exactly as a
-- gateway split has a payment_events row plus its allocation settlements.
--
--   amount_cents   THE SERVER'S FIGURE, integer cents, what was collected INCLUDING any gratuity
--                  (the same meaning payment_events.amount has for a gateway charge). Never a
--                  client figure: every writer computes it from lib/orders/order-financials.ts or
--                  from the allocation ledger.
--   tip_cents      the gratuity part of amount_cents (payment_tips holds the attribution).
--                  bill = amount_cents - tip_cents.
--   origin         WHO/WHAT RECORDED IT. Distinguishes a dashboard Mark-as-Paid from a terminal
--                  settle; `method` distinguishes cash / standalone card machine / PayToday.
--   recorded_by    the staff user, when one is proven (dashboard session, or a PIN-consumed
--                  terminal token); NULL only for a terminal settle with no PIN, in which case
--                  actor_attribution says 'terminal_only' and terminal_id names the device.
--
-- ==================================================================================================
-- IMMUTABLE
-- ==================================================================================================
--
-- UPDATE, DELETE and TRUNCATE are refused by trigger, for every role including the owner. There is
-- no correction path by design: a mistaken manual payment is corrected by a NEW record (a refund
-- when one exists), never by rewriting this one. No foreign key cascades onto this table either:
-- restaurant_id and recorded_by are NO ACTION references, so deleting a restaurant or a user who
-- has ledger rows fails rather than silently taking financial history with it.
--
-- payment_events itself has NO such trigger and this migration does not add one: the committed
-- operator scripts under scripts/prod (wipe-riviera-pre-launch-orders-production.ts,
-- delete-324-orphan-orders.ts) delete from it, and changing that table's protection is a separate
-- ruling. Stated so nobody reads this migration as having made it immutable.
--
-- SAFE TO APPLY: additive (one new table, one trigger function, one new RPC). Nothing existing is
-- redefined or altered.

CREATE TABLE IF NOT EXISTS public.non_gateway_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),

  origin text NOT NULL CHECK (origin IN (
    -- PATCH /api/orders/[orderId]/status, Mark-as-Paid (record_manual_order_payment below).
    'staff_mark_paid',
    -- POST /api/terminal/tabs/[tabId]/settle with a non-gateway method.
    'terminal_tab_settle',
    -- POST /api/terminal/tabs/[tabId]/settle-allocations, cash.
    'terminal_allocation_settle',
    -- POST /api/terminal/orders/[orderId]/payment reporting a non-gateway success.
    'terminal_order_payment'
  )),

  -- 'card' HERE MEANS A STANDALONE CARD MACHINE the staff member used outside FlashTap: there is no
  -- FlashTap gateway transaction behind it, which is exactly why it is in this table.
  method text NOT NULL CHECK (method IN ('cash', 'card', 'paytoday')),

  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  tip_cents integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  currency text NOT NULL DEFAULT 'NAD',

  order_ids uuid[] NOT NULL CHECK (cardinality(order_ids) > 0),
  tab_id uuid,
  -- Present exactly for an item-split settlement.
  allocation_ids uuid[],

  -- The FlashTap reference written onto the orders (orders.payment_reference) and payment_tips.
  payment_reference text NOT NULL CHECK (btrim(payment_reference) <> ''),
  -- One collection event, one row. See each writer for its key.
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),

  recorded_by uuid REFERENCES public.users(id),
  actor_attribution text NOT NULL CHECK (actor_attribution IN (
    'staff_session', 'staff_authorized', 'terminal_only')),
  terminal_id text,
  source text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT non_gateway_payment_events_tip_below_amount CHECK (tip_cents < amount_cents),
  CONSTRAINT non_gateway_payment_events_allocations_match_origin CHECK (
    (origin = 'terminal_allocation_settle')
      = (allocation_ids IS NOT NULL AND cardinality(allocation_ids) > 0)),
  -- A named actor is required wherever the attribution claims one.
  CONSTRAINT non_gateway_payment_events_actor_present CHECK (
    (actor_attribution = 'terminal_only') OR (recorded_by IS NOT NULL)),
  -- The dashboard path is always a signed-in staff member.
  CONSTRAINT non_gateway_payment_events_mark_paid_has_actor CHECK (
    origin <> 'staff_mark_paid' OR actor_attribution = 'staff_session'),
  CONSTRAINT non_gateway_payment_events_idempotency_key UNIQUE (restaurant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS non_gateway_payment_events_order_ids_gin_idx
  ON public.non_gateway_payment_events USING GIN (order_ids);
CREATE INDEX IF NOT EXISTS non_gateway_payment_events_restaurant_created_idx
  ON public.non_gateway_payment_events (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS non_gateway_payment_events_payment_reference_idx
  ON public.non_gateway_payment_events (restaurant_id, payment_reference);

COMMENT ON TABLE public.non_gateway_payment_events IS
  'Immutable ledger of every SUCCESSFUL payment FlashTap did not see a gateway confirm (manual '
  'Mark-as-Paid, cash / PayToday / standalone-card settlements). The complement of payment_events, '
  'which stays gateway-only so none of its readers can mistake a manual payment for a gateway one. '
  'UPDATE/DELETE/TRUNCATE are refused by trigger. Sprint 2026-09-29 brief.';
COMMENT ON COLUMN public.non_gateway_payment_events.amount_cents IS
  'Server-computed amount collected, integer cents, gratuity INCLUDED (bill = amount_cents - '
  'tip_cents). Never a client figure.';

-- ---------------------------------------------------------------------------------------------
-- Immutability.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.non_gateway_payment_events_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'non_gateway_payment_events is an immutable ledger: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Record a new event (e.g. a refund) instead of changing or removing this one.';
END;
$$;

ALTER FUNCTION public.non_gateway_payment_events_refuse_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.non_gateway_payment_events_refuse_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS non_gateway_payment_events_immutable ON public.non_gateway_payment_events;
CREATE TRIGGER non_gateway_payment_events_immutable
  BEFORE UPDATE OR DELETE ON public.non_gateway_payment_events
  FOR EACH ROW
  EXECUTE FUNCTION public.non_gateway_payment_events_refuse_change();

DROP TRIGGER IF EXISTS non_gateway_payment_events_no_truncate ON public.non_gateway_payment_events;
CREATE TRIGGER non_gateway_payment_events_no_truncate
  BEFORE TRUNCATE ON public.non_gateway_payment_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.non_gateway_payment_events_refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Access. Written only by the service role (the API routes and the RPC below); read by staff
-- holding payments:read, the same predicate payment_events uses.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.non_gateway_payment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read non-gateway payment events"
  ON public.non_gateway_payment_events;
CREATE POLICY "Authorized staff can read non-gateway payment events"
  ON public.non_gateway_payment_events
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'payments:read'));

REVOKE ALL ON TABLE public.non_gateway_payment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.non_gateway_payment_events TO authenticated;
-- No UPDATE/DELETE grant to anyone: the trigger is the enforcement, this is the declaration.
REVOKE ALL ON TABLE public.non_gateway_payment_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.non_gateway_payment_events TO service_role;

-- ---------------------------------------------------------------------------------------------
-- record_manual_order_payment: Mark-as-Paid as ONE transaction.
-- ---------------------------------------------------------------------------------------------
--
-- Replaces the route-level sequence in lib/payments/mark-order-paid-manually.ts (786dd972), which
-- wrote the order, a `payments` row and an audit row as three statements and, when the audit row
-- failed, UNDID the order and DELETED the payments row. An undo that deletes is incompatible with
-- an immutable ledger row, so the whole thing is one transaction instead: the conditional claim,
-- the settlement anchor, the ledger row and the audit row all land or none do.
--
-- THE AMOUNT IS THE CALLER'S SERVER FIGURE. The live outstanding amount is computed by
-- lib/orders/order-financials.ts (contract C1: nobody re-derives it), so it is passed in; this
-- function trusts its caller for the figure exactly as settle_order_line_allocations does, and it
-- is EXECUTE-able by service_role only.
--
-- IDEMPOTENT: the ledger key is 'staff_mark_paid:<order id>'. An order leaves `paid` only through
-- a refund, never back to a settleable state, so one order can be marked paid by hand at most
-- once; a replay that somehow passed the claim would raise 23505 and roll everything back.
CREATE OR REPLACE FUNCTION public.record_manual_order_payment(
  p_restaurant_id uuid,
  p_order_id uuid,
  -- The payment_status the caller READ and validated. The claim is conditioned on it.
  p_expected_payment_status text,
  p_method text,
  p_amount_cents integer,
  p_payment_reference text,
  p_staff_user_id uuid,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order      record;
  v_status     text;
  v_method     text := lower(btrim(COALESCE(p_method, '')));
  v_paid_at    timestamptz := now();
  v_payment_id uuid;
  v_ledger_id  uuid;
BEGIN
  IF v_method NOT IN ('cash', 'card', 'paytoday') THEN
    RAISE EXCEPTION 'record_manual_order_payment: unsupported payment method %', p_method;
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'record_manual_order_payment: amount must be positive cents, got %', p_amount_cents;
  END IF;
  IF p_staff_user_id IS NULL THEN
    RAISE EXCEPTION 'record_manual_order_payment: a manual payment needs the staff member recording it';
  END IF;
  IF p_payment_reference IS NULL OR btrim(p_payment_reference) = '' THEN
    RAISE EXCEPTION 'record_manual_order_payment: a payment reference is required';
  END IF;

  -- RESTAURANT-SCOPED, and locked: another restaurant's order is simply not found.
  SELECT id, tab_id, payment_status
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id
     AND restaurant_id = p_restaurant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;

  IF v_order.payment_status IS DISTINCT FROM p_expected_payment_status THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_status_changed',
      'payment_status', v_order.payment_status);
  END IF;

  v_status := lower(btrim(COALESCE(v_order.payment_status, '')));
  IF v_status = 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
  END IF;
  -- CASH_SETTLEABLE_PAYMENT_STATUSES (lib/payments/payment-integrity.ts). Anything else carries,
  -- or may carry, a card payment, or has been cancelled.
  IF v_status NOT IN ('unpaid', 'pending', 'cash_pending', 'failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_settleable',
      'payment_status', v_order.payment_status);
  END IF;

  UPDATE public.orders
     SET payment_status       = 'paid',
         payment_method       = v_method,
         payment_reference    = p_payment_reference,
         paid_at              = v_paid_at,
         -- Explicit, so orders_record_settled_charge keeps it: what THIS payment collected.
         settled_charge_cents = p_amount_cents
   WHERE id = p_order_id
     AND restaurant_id = p_restaurant_id;

  -- The settlement anchor the tab settle route writes for the same methods (payment_tips.payment_id
  -- points at it). Kept for continuity; the ledger row below is the record.
  INSERT INTO public.payments
    (restaurant_id, tab_id, order_ids, amount, method, status, gateway_reference,
     payment_reference, completed_at)
  VALUES
    (p_restaurant_id, v_order.tab_id, ARRAY[p_order_id], p_amount_cents::numeric / 100, v_method,
     'completed', NULL, p_payment_reference, v_paid_at)
  RETURNING id INTO v_payment_id;

  INSERT INTO public.non_gateway_payment_events
    (restaurant_id, origin, method, amount_cents, tip_cents, order_ids, tab_id, payment_reference,
     idempotency_key, recorded_by, actor_attribution, source)
  VALUES
    (p_restaurant_id, 'staff_mark_paid', v_method, p_amount_cents, 0, ARRAY[p_order_id],
     v_order.tab_id, p_payment_reference, 'staff_mark_paid:' || p_order_id::text,
     p_staff_user_id, 'staff_session', COALESCE(p_source, 'orders/status'))
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_restaurant_id,
    'payment.marked_paid_manually',
    'order',
    p_order_id::text,
    jsonb_build_object(
      'source', COALESCE(p_source, 'orders/status'),
      'staff_user_id', p_staff_user_id,
      'method', v_method,
      'amount', p_amount_cents::numeric / 100,
      'amount_cents', p_amount_cents,
      'amount_basis', 'order_financials_outstanding',
      'previous_payment_status', v_order.payment_status,
      'payment_reference', p_payment_reference,
      -- Stated, not implied: nothing but this person's word stands behind a manual payment.
      'gateway_verified', false,
      'payment_record_written', true,
      'ledger_event_id', v_ledger_id,
      'recorded_at', v_paid_at));

  RETURN jsonb_build_object(
    'ok', true,
    'ledger_event_id', v_ledger_id,
    'payment_id', v_payment_id,
    'paid_at', v_paid_at,
    'tab_id', v_order.tab_id);
END;
$$;

ALTER FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  TO service_role;
