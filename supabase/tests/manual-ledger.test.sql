-- DATABASE TESTS for the non-gateway payment ledger and record_manual_order_payment()
-- (20260929100000, Sprint 2026-09-29 brief).
--
-- Run by supabase/tests/run-db-tests.mjs AFTER settlement-rpc.test.sql and amend-rpc.test.sql,
-- whose _test_results, _expect() and _seed() it reuses.
--
-- THE LEDGER IS IMMUTABLE, SO THESE TESTS CANNOT CLEAN UP THE WAY THE OTHERS DO. _seed() deletes
-- restaurants, users and tabs; a ledger row still pointing at them would make that fail (NO ACTION
-- FKs, and a trigger refusing DELETE). _ml_cleanup() therefore removes this file's rows with
-- session_replication_role = replica -- a superuser-only switch that disables user triggers -- and
-- resets it immediately. That is a TEST HARNESS bypass on a throwaway database, used before and
-- after this file runs; it is not a path the application has, and the immutability assertions
-- below run with the triggers live.

CREATE OR REPLACE FUNCTION public._ml_cleanup()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  DELETE FROM public.non_gateway_payment_events;
  DELETE FROM public.payments;
  PERFORM set_config('session_replication_role', 'origin', true);
END;
$$;

CREATE OR REPLACE FUNCTION public._ml_seed()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._ml_cleanup();
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, tab_id, order_number, status, payment_status, payment_method, total)
  VALUES
    -- N$220, pending: the ordinary Mark-as-Paid.
    ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
     '22222222-2222-4222-8222-222222222222', 1, 'preparing', 'pending', NULL, 220),
    -- A card attempt is live on this one.
    ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
     '22222222-2222-4222-8222-222222222222', 2, 'preparing', 'terminal_pending', 'card', 100),
    -- ANOTHER RESTAURANT'S order.
    ('bbbbbbbb-0000-4000-8000-000000000003', '99999999-9999-4999-8999-999999999999',
     NULL, 3, 'preparing', 'pending', NULL, 50),
    ('bbbbbbbb-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
     NULL, 4, 'cancelled', 'cancelled', NULL, 80);
END;
$$;

-- The one call every test makes, so a signature change fails loudly in one place.
CREATE OR REPLACE FUNCTION public._ml_mark_paid(
  p_order uuid, p_expected text, p_amount integer DEFAULT 22000, p_method text DEFAULT 'cash',
  p_restaurant uuid DEFAULT '11111111-1111-4111-8111-111111111111',
  p_staff uuid DEFAULT '55555555-5555-4555-8555-555555555555')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.record_manual_order_payment(
    p_restaurant, p_order, p_expected, p_method, p_amount, 'PAY-ML-' || left(p_order::text, 8),
    p_staff, 'orders/status');
$$;

-- ==================================================================================================
-- ML1. A manual payment writes EXACTLY ONE immutable ledger row, with the server's amount, the
-- method, the staff member, and no gateway anything.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_manual_payment()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  n integer;
  ev record;
  o record;
  aud record;
BEGIN
  PERFORM public._ml_seed();
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending', 22000, 'cash');
  PERFORM public._expect('ml_pay/rpc_ok', (r->>'ok')::boolean, r::text);

  SELECT count(*) INTO n FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_pay/one_ledger_row', n = 1, format('%s ledger rows', n));

  SELECT * INTO ev FROM public.non_gateway_payment_events LIMIT 1;
  PERFORM public._expect('ml_pay/amount_is_server_figure', ev.amount_cents = 22000,
    format('amount_cents %s', ev.amount_cents));
  PERFORM public._expect('ml_pay/method', ev.method = 'cash', ev.method);
  PERFORM public._expect('ml_pay/staff_actor',
    ev.recorded_by = '55555555-5555-4555-8555-555555555555'
      AND ev.actor_attribution = 'staff_session',
    format('%s / %s', ev.recorded_by, ev.actor_attribution));
  PERFORM public._expect('ml_pay/origin', ev.origin = 'staff_mark_paid', ev.origin);
  PERFORM public._expect('ml_pay/scope',
    ev.restaurant_id = '11111111-1111-4111-8111-111111111111'
      AND ev.order_ids = ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[]
      AND ev.tab_id = '22222222-2222-4222-8222-222222222222',
    format('%s %s %s', ev.restaurant_id, ev.order_ids, ev.tab_id));
  PERFORM public._expect('ml_pay/idempotency_key',
    ev.idempotency_key = 'staff_mark_paid:bbbbbbbb-0000-4000-8000-000000000001', ev.idempotency_key);
  PERFORM public._expect('ml_pay/returned_ledger_id', (r->>'ledger_event_id')::uuid = ev.id, r::text);

  -- NOT A GATEWAY PAYMENT, in either ledger.
  SELECT count(*) INTO n FROM public.payment_events;
  PERFORM public._expect('ml_pay/gateway_ledger_untouched', n = 0, format('%s payment_events', n));

  SELECT * INTO o FROM public.orders WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  PERFORM public._expect('ml_pay/order_paid',
    o.payment_status = 'paid' AND o.payment_method = 'cash'
      AND o.payment_reference = ev.payment_reference AND o.settled_charge_cents = 22000
      AND o.paycloud_merchant_order_no IS NULL AND o.paycloud_transaction_id IS NULL
      AND o.payment_voucher_no IS NULL,
    format('%s %s %s %s', o.payment_status, o.payment_method, o.payment_reference, o.settled_charge_cents));

  SELECT count(*) INTO n FROM public.payments
   WHERE payment_reference = ev.payment_reference AND amount = 220 AND gateway_reference IS NULL;
  PERFORM public._expect('ml_pay/settlement_anchor', n = 1, format('%s payments rows', n));

  SELECT * INTO aud FROM public.audit_logs WHERE action = 'payment.marked_paid_manually';
  PERFORM public._expect('ml_pay/audit_row',
    aud.metadata->>'ledger_event_id' = ev.id::text
      AND (aud.metadata->>'gateway_verified')::boolean = false
      AND aud.metadata->>'staff_user_id' = '55555555-5555-4555-8555-555555555555',
    COALESCE(aud.metadata::text, 'no audit row'));
END;
$$;

-- ==================================================================================================
-- ML2. A replay does not create a second row -- through the claim, AND through the key when the
-- claim is bypassed.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_replay()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  n integer;
  v_threw boolean := false;
  v_state text;
BEGIN
  PERFORM public._ml_seed();
  PERFORM public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending');

  -- The double click: the second request read `pending` before the first committed.
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending');
  PERFORM public._expect('ml_replay/second_refused',
    NOT (r->>'ok')::boolean AND r->>'reason' = 'payment_status_changed', r::text);
  -- A caller that re-read: already paid.
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'paid');
  PERFORM public._expect('ml_replay/already_paid', r->>'reason' = 'already_paid', r::text);

  SELECT count(*) INTO n FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_replay/one_ledger_row', n = 1, format('%s rows', n));

  -- DEFENCE IN DEPTH: even if the order were somehow back in a settleable state, the ledger key
  -- refuses a second manual payment of the same order and the whole transaction rolls back.
  UPDATE public.orders SET payment_status = 'pending'
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  BEGIN
    r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending');
  EXCEPTION WHEN unique_violation THEN
    v_threw := true;
  END;
  PERFORM public._expect('ml_replay/unique_key_refuses_second_row', v_threw,
    'a second staff_mark_paid for one order was accepted');
  SELECT count(*) INTO n FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_replay/still_one_row', n = 1, format('%s rows', n));
  SELECT payment_status INTO v_state FROM public.orders
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  PERFORM public._expect('ml_replay/rolled_back_whole', v_state = 'pending', v_state);
END;
$$;

-- ==================================================================================================
-- ML3. Another restaurant's order is refused and nothing is written.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_cross_restaurant()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  n integer;
  v_state text;
BEGIN
  PERFORM public._ml_seed();
  -- Riviera's staff, Riviera's restaurant id, the OTHER venue's order.
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000003', 'pending', 5000);
  PERFORM public._expect('ml_cross/refused',
    NOT COALESCE((r->>'ok')::boolean, false) AND r->>'reason' = 'order_not_found', r::text);
  SELECT count(*) INTO n FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_cross/no_ledger_row', n = 0, format('%s rows', n));
  SELECT payment_status INTO v_state FROM public.orders
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003';
  PERFORM public._expect('ml_cross/order_untouched', v_state = 'pending', v_state);
  SELECT count(*) INTO n FROM public.audit_logs;
  PERFORM public._expect('ml_cross/no_audit', n = 0, format('%s audit rows', n));
END;
$$;

-- ==================================================================================================
-- ML4. Refusals: a card in flight, a cancelled order, a bad method, a zero amount, no staff member.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_refusals()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  n integer;
  v_threw boolean;
BEGIN
  PERFORM public._ml_seed();
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000002', 'terminal_pending', 10000);
  PERFORM public._expect('ml_refuse/card_in_flight', r->>'reason' = 'not_settleable', r::text);
  r := public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000004', 'cancelled', 8000);
  PERFORM public._expect('ml_refuse/cancelled', r->>'reason' = 'not_settleable', r::text);

  v_threw := false;
  BEGIN
    PERFORM public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending', 22000, 'bitcoin');
  EXCEPTION WHEN OTHERS THEN v_threw := true;
  END;
  PERFORM public._expect('ml_refuse/method', v_threw, 'an unknown method was accepted');

  v_threw := false;
  BEGIN
    PERFORM public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending', 0);
  EXCEPTION WHEN OTHERS THEN v_threw := true;
  END;
  PERFORM public._expect('ml_refuse/zero_amount', v_threw, 'a zero amount was accepted');

  v_threw := false;
  BEGIN
    PERFORM public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending', 22000, 'cash',
      '11111111-1111-4111-8111-111111111111', NULL);
  EXCEPTION WHEN OTHERS THEN v_threw := true;
  END;
  PERFORM public._expect('ml_refuse/no_staff', v_threw, 'a manual payment with no staff member was accepted');

  SELECT count(*) INTO n FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_refuse/nothing_written', n = 0, format('%s rows', n));
END;
$$;

-- ==================================================================================================
-- ML5. IMMUTABLE: UPDATE, DELETE and TRUNCATE are refused, and the row survives each attempt.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_immutable()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  v_threw boolean;
  v_amount integer;
BEGIN
  PERFORM public._ml_seed();
  PERFORM public._ml_mark_paid('bbbbbbbb-0000-4000-8000-000000000001', 'pending');

  v_threw := false;
  BEGIN
    UPDATE public.non_gateway_payment_events SET amount_cents = 1;
  EXCEPTION WHEN OTHERS THEN v_threw := SQLERRM LIKE '%immutable ledger%';
  END;
  PERFORM public._expect('ml_immutable/update_refused', v_threw, 'UPDATE of a ledger row succeeded');

  v_threw := false;
  BEGIN
    DELETE FROM public.non_gateway_payment_events;
  EXCEPTION WHEN OTHERS THEN v_threw := SQLERRM LIKE '%immutable ledger%';
  END;
  PERFORM public._expect('ml_immutable/delete_refused', v_threw, 'DELETE of a ledger row succeeded');

  v_threw := false;
  BEGIN
    TRUNCATE public.non_gateway_payment_events;
  EXCEPTION WHEN OTHERS THEN v_threw := SQLERRM LIKE '%immutable ledger%';
  END;
  PERFORM public._expect('ml_immutable/truncate_refused', v_threw, 'TRUNCATE of the ledger succeeded');

  SELECT count(*), max(amount_cents) INTO n, v_amount FROM public.non_gateway_payment_events;
  PERFORM public._expect('ml_immutable/row_intact', n = 1 AND v_amount = 22000,
    format('%s rows, amount %s', n, v_amount));

  -- Deleting the restaurant that owns ledger rows is refused, not cascaded.
  -- The settlement anchor is not immutable; removed so the only thing that can refuse is the ledger.
  DELETE FROM public.payments;
  v_threw := false;
  BEGIN
    DELETE FROM public.restaurants WHERE id = '11111111-1111-4111-8111-111111111111';
  EXCEPTION WHEN OTHERS THEN v_threw := SQLERRM LIKE '%non_gateway_payment_events%';
  END;
  PERFORM public._expect('ml_immutable/no_cascade_from_restaurant', v_threw,
    'deleting the restaurant took its ledger rows with it');
END;
$$;

-- ==================================================================================================
-- ML6. Shape constraints, straight on the table.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_constraints()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_threw boolean;
BEGIN
  PERFORM public._ml_seed();

  INSERT INTO public.non_gateway_payment_events
    (restaurant_id, origin, method, amount_cents, order_ids, payment_reference, idempotency_key,
     actor_attribution, source)
  VALUES ('11111111-1111-4111-8111-111111111111', 'terminal_tab_settle', 'cash', 1000,
    ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K', 'k1', 'terminal_only', 't');

  v_threw := false;
  BEGIN
    INSERT INTO public.non_gateway_payment_events
      (restaurant_id, origin, method, amount_cents, order_ids, payment_reference, idempotency_key,
       actor_attribution, source)
    VALUES ('11111111-1111-4111-8111-111111111111', 'terminal_tab_settle', 'cash', 1000,
      ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K2', 'k1', 'terminal_only', 't');
  EXCEPTION WHEN unique_violation THEN v_threw := true;
  END;
  PERFORM public._expect('ml_unique/duplicate_refused', v_threw, 'a duplicate idempotency key was accepted');

  v_threw := false;
  BEGIN
    INSERT INTO public.non_gateway_payment_events
      (restaurant_id, origin, method, amount_cents, tip_cents, order_ids, payment_reference,
       idempotency_key, actor_attribution, source)
    VALUES ('11111111-1111-4111-8111-111111111111', 'terminal_tab_settle', 'cash', 1000, 1000,
      ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K3', 'k3', 'terminal_only', 't');
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  PERFORM public._expect('ml_shape/tip_must_be_below_amount', v_threw, 'tip >= amount accepted');

  v_threw := false;
  BEGIN
    INSERT INTO public.non_gateway_payment_events
      (restaurant_id, origin, method, amount_cents, order_ids, payment_reference, idempotency_key,
       actor_attribution, source)
    VALUES ('11111111-1111-4111-8111-111111111111', 'staff_mark_paid', 'cash', 1000,
      ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K4', 'k4', 'terminal_only', 't');
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  PERFORM public._expect('ml_shape/mark_paid_needs_staff', v_threw, 'an anonymous Mark-as-Paid row accepted');

  v_threw := false;
  BEGIN
    INSERT INTO public.non_gateway_payment_events
      (restaurant_id, origin, method, amount_cents, order_ids, payment_reference, idempotency_key,
       actor_attribution, source)
    VALUES ('11111111-1111-4111-8111-111111111111', 'terminal_allocation_settle', 'cash', 1000,
      ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K5', 'k5', 'terminal_only', 't');
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  PERFORM public._expect('ml_shape/allocation_origin_needs_allocations', v_threw,
    'an allocation settlement with no allocation ids accepted');

  v_threw := false;
  BEGIN
    INSERT INTO public.non_gateway_payment_events
      (restaurant_id, origin, method, amount_cents, order_ids, payment_reference, idempotency_key,
       actor_attribution, source)
    VALUES ('11111111-1111-4111-8111-111111111111', 'terminal_tab_settle', 'hosted_checkout', 1000,
      ARRAY['bbbbbbbb-0000-4000-8000-000000000001']::uuid[], 'PAY-K6', 'k6', 'terminal_only', 't');
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  PERFORM public._expect('ml_shape/gateway_method_refused', v_threw,
    'a gateway (hosted_checkout) method was accepted into the non-gateway ledger');
END;
$$;

-- ==================================================================================================
-- ML7. SECURITY. Only the service role may execute the RPC or write the ledger. Positive control:
-- mutation ML5 grants it to anon and these must go red.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_ml_security()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_sig text := 'public.record_manual_order_payment(uuid, uuid, text, text, integer, text, uuid, text)';
BEGIN
  PERFORM public._expect('ml_security/function_exists', to_regprocedure(v_sig) IS NOT NULL, v_sig);
  PERFORM public._expect('ml_security/anon_cannot_execute',
    NOT has_function_privilege('anon', v_sig, 'EXECUTE'), 'anon can execute');
  PERFORM public._expect('ml_security/authenticated_cannot_execute',
    NOT has_function_privilege('authenticated', v_sig, 'EXECUTE'), 'authenticated can execute');
  PERFORM public._expect('ml_security/service_role_can_execute',
    has_function_privilege('service_role', v_sig, 'EXECUTE'), 'service_role cannot execute');
  PERFORM public._expect('ml_security/anon_cannot_insert',
    NOT has_table_privilege('anon', 'public.non_gateway_payment_events', 'INSERT'), 'anon can insert');
  PERFORM public._expect('ml_security/authenticated_cannot_insert',
    NOT has_table_privilege('authenticated', 'public.non_gateway_payment_events', 'INSERT'),
    'authenticated can insert');
  PERFORM public._expect('ml_security/service_role_cannot_update',
    NOT has_table_privilege('service_role', 'public.non_gateway_payment_events', 'UPDATE')
      AND NOT has_table_privilege('service_role', 'public.non_gateway_payment_events', 'DELETE'),
    'service_role holds UPDATE or DELETE');
  PERFORM public._expect('ml_security/service_role_can_insert',
    has_table_privilege('service_role', 'public.non_gateway_payment_events', 'INSERT'),
    'service_role cannot insert (positive control for the refusals above)');
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_ml_manual_payment',
    '_t_ml_replay',
    '_t_ml_cross_restaurant',
    '_t_ml_refusals',
    '_t_ml_immutable',
    '_t_ml_constraints',
    '_t_ml_security'
  ];
BEGIN
  FOREACH t IN ARRAY tests LOOP
    BEGIN
      EXECUTE format('SELECT public.%I()', t);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._test_results (name, passed, detail)
      VALUES (t || '/threw', false, SQLERRM)
      ON CONFLICT (name) DO UPDATE SET passed = false, detail = EXCLUDED.detail;
      RAISE WARNING 'THREW % -- %', t, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Leave nothing behind that would block the next _seed() (the race probes reuse this database).
SELECT public._ml_cleanup();
