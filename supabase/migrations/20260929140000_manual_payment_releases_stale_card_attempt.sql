-- @env: both
--
-- A MANUAL / NON-GATEWAY PAYMENT IS A FRESH CHARGE AT THE LIVE AMOUNT (team-lead ruling,
-- Sprint 2026-09-29, on the FTCHG interaction with 20260929120000).
--
-- ==================================================================================================
-- THE RULING
-- ==================================================================================================
--
-- A payment FlashTap did not see a gateway confirm -- Mark-as-Paid, cash or PayToday on the terminal
-- -- must neither SETTLE a stale card attempt nor RACE a live one:
--
--   a prepared card charge whose pending_charge_at is INSIDE the in-flight window (5 minutes, the
--   window orders_refuse_edit_during_charge in 20260929120000 uses) may really be running on a
--   reader  -> REFUSED, 'payment_in_flight'.
--
--   a prepared charge OLDER than the window is a dead attempt -> RELEASED explicitly, in the SAME
--   transaction as the payment that replaces it: pending_charge_* cleared (the 20260929120000 stamp
--   trigger then clears its basis and timestamp), any still-`launched` intent covering the order
--   marked `failed`, and one `payment.stale_card_attempt_released` audit row per order. So the
--   paid-guard trigger never sees a stale basis on a legitimate manual payment, and it is NOT
--   weakened to achieve that.
--
--   an intent in `uncertain` -- the gateway's answer is not known -- is never moved by anything but a
--   gateway answer (lib/payments/payment-intents.ts). A manual payment over it could be the second
--   charge, so it is refused as in flight too.
--
-- A still-`launched` intent created inside the window counts as in flight even if the order carries
-- no prepared figure (a split charge prepares the intent, not the order).
--
-- ==================================================================================================
-- DEPENDENCIES AND SAFETY
-- ==================================================================================================
--
-- Reads orders.pending_charge_at, added by 20260929120000 (f-race), and sets the transaction-local
-- non-gateway marker that migration's paid guard honours -- so its VERSION sorts after that series
-- (renamed from 20260929100100 at the lead's direction).
--
-- Additive: one new function; record_manual_order_payment (this sprint's own, 20260929100000) is
-- redefined from its exact body with the release step added and its grants restated. Nothing else
-- is touched.

CREATE OR REPLACE FUNCTION public.release_stale_card_attempts(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_source text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- THE in-flight window. Same figure as orders_refuse_edit_during_charge (20260929120000).
  v_window      interval := interval '5 minutes';
  v_row         record;
  v_in_flight   uuid[] := ARRAY[]::uuid[];
  v_stale       uuid[] := ARRAY[]::uuid[];
  v_uncertain   uuid[] := ARRAY[]::uuid[];
  v_live_intent uuid[] := ARRAY[]::uuid[];
  v_expired     uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_order_ids IS NULL OR cardinality(p_order_ids) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'released_order_ids', '[]'::jsonb,
      'expired_intent_ids', '[]'::jsonb);
  END IF;

  -- Locked, in id order (the settlement's lock order), and scoped to the restaurant.
  FOR v_row IN
    SELECT id, pending_charge_cents, pending_tip_cents, pending_charge_at
      FROM public.orders
     WHERE id = ANY (p_order_ids)
       AND restaurant_id = p_restaurant_id
     ORDER BY id
     FOR UPDATE
  LOOP
    IF v_row.pending_charge_cents IS NULL THEN
      CONTINUE;
    END IF;
    -- FAILS CLOSED on a missing timestamp, as the edit guard does.
    IF v_row.pending_charge_at IS NULL OR v_row.pending_charge_at > now() - v_window THEN
      v_in_flight := v_in_flight || v_row.id;
    ELSE
      v_stale := v_stale || v_row.id;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_uncertain
    FROM public.terminal_payment_intents
   WHERE restaurant_id = p_restaurant_id
     AND status = 'uncertain'
     AND order_ids && p_order_ids;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_live_intent
    FROM public.terminal_payment_intents
   WHERE restaurant_id = p_restaurant_id
     AND status = 'launched'
     AND order_ids && p_order_ids
     AND created_at > now() - v_window;

  IF cardinality(v_in_flight) > 0 OR cardinality(v_uncertain) > 0 OR cardinality(v_live_intent) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'payment_in_flight',
      'in_flight_order_ids', to_jsonb(v_in_flight),
      'uncertain_intent_ids', to_jsonb(v_uncertain),
      'live_intent_ids', to_jsonb(v_live_intent));
  END IF;

  -- THE RELEASE. Clearing pending_charge_cents is what ends an attempt; the stamp trigger clears
  -- its basis, timestamp and read basis with it.
  IF cardinality(v_stale) > 0 THEN
    INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
    SELECT p_restaurant_id,
           'payment.stale_card_attempt_released',
           'order',
           o.id::text,
           jsonb_build_object(
             'source', p_source,
             'actor_user_id', p_actor_user_id,
             'released_charge_cents', o.pending_charge_cents,
             'released_tip_cents', o.pending_tip_cents,
             'charge_prepared_at', o.pending_charge_at,
             'in_flight_window_seconds', extract(epoch FROM v_window)::integer,
             'note', 'A card charge prepared longer ago than the in-flight window was released so a '
               || 'non-gateway payment could be recorded at the live amount. If the gateway later '
               || 'confirms that attempt, the settlement is held as paid by another payment.')
      FROM public.orders o
     WHERE o.id = ANY (v_stale);

    UPDATE public.orders
       SET pending_charge_cents      = NULL,
           pending_tip_cents         = 0,
           pending_tip_staff_user_id = NULL,
           pending_settlement_id     = NULL
     WHERE id = ANY (v_stale)
       AND restaurant_id = p_restaurant_id;
  END IF;

  -- A launched intent older than the window is the same dead attempt, seen from the gateway side.
  WITH expired AS (
    UPDATE public.terminal_payment_intents
       SET status = 'failed', resolved_at = now()
     WHERE restaurant_id = p_restaurant_id
       AND status = 'launched'
       AND order_ids && p_order_ids
     RETURNING id)
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_expired FROM expired;

  RETURN jsonb_build_object(
    'ok', true,
    'released_order_ids', to_jsonb(v_stale),
    'expired_intent_ids', to_jsonb(v_expired));
END;
$$;

ALTER FUNCTION public.release_stale_card_attempts(uuid, uuid[], text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_stale_card_attempts(uuid, uuid[], text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stale_card_attempts(uuid, uuid[], text, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- record_manual_order_payment, REDEFINED: 20260929100000's body exactly, plus the release step.
-- ---------------------------------------------------------------------------------------------
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
  v_release    jsonb;
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

  -- A MANUAL PAYMENT IS A FRESH CHARGE AT THE LIVE AMOUNT (team-lead ruling, 20260929140000). It
  -- never races a card attempt that may really be running, and it never settles a stale one: a
  -- prepared charge inside the in-flight window refuses; an older one is released here, in this
  -- transaction, before the order is claimed.
  v_release := public.release_stale_card_attempts(
    p_restaurant_id, ARRAY[p_order_id], COALESCE(p_source, 'orders/status'), p_staff_user_id);
  IF NOT COALESCE((v_release->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_in_flight',
      'in_flight_order_ids', v_release->'in_flight_order_ids',
      'uncertain_intent_ids', v_release->'uncertain_intent_ids');
  END IF;

  -- NOT A GATEWAY CHARGE. The transaction-local marker f-race's paid guard (20260929120000,
  -- orders_refuse_paid_on_changed_charge) honours: a manual payment is recorded at the live figure
  -- computed above, never against a prepared card charge. Local to this transaction (third argument
  -- true), so it ends with the RPC; it cannot be set through a PostgREST table write.
  PERFORM set_config('flashtap.non_gateway_payment', 'on', true);

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
      'released_stale_card_attempt', jsonb_array_length(COALESCE(v_release->'released_order_ids', '[]'::jsonb)) > 0,
      'recorded_at', v_paid_at));

  RETURN jsonb_build_object(
    'ok', true,
    'ledger_event_id', v_ledger_id,
    'payment_id', v_payment_id,
    'paid_at', v_paid_at,
    'tab_id', v_order.tab_id,
    'released_order_ids', v_release->'released_order_ids',
    'expired_intent_ids', v_release->'expired_intent_ids');
END;
$$;

ALTER FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)
  TO service_role;
