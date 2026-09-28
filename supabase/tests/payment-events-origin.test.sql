-- DATABASE TESTS for 20260929110000_payment_events_origin.sql (Sprint 2026-09-29, task 7).
--
-- Run by supabase/tests/run-db-tests.mjs AFTER settlement-rpc.test.sql, whose _test_results,
-- _expect() and _seed() it reuses. Throwaway local Postgres only.

-- ==================================================================================================
-- O1. A device report is recorded as one, with its amount check.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_device_row()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE ev record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000301', '11111111-1111-4111-8111-111111111111',
          301, 'pending', 'pending', 100);

  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000301']::uuid[], 'sale', 'MO-O1', 'MO-O1',
          'TXN-O1', 1.00, 'MO-O1', 'sale', 'terminal_device', 'mismatch_intent');

  SELECT * INTO ev FROM public.payment_events WHERE business_order_no = 'MO-O1';
  PERFORM public._expect('origin/device_row_recorded',
    ev.origin = 'terminal_device' AND ev.device_amount_check = 'mismatch_intent',
    format('origin=%s check=%s', ev.origin, ev.device_amount_check));
END;
$$;

-- ==================================================================================================
-- O2. An origin nobody defined is refused. (Mutation MO1 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_unknown_refused()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE refused boolean := false;
BEGIN
  PERFORM public._seed();
  BEGIN
    INSERT INTO public.payment_events
      (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
       transaction_id, amount, idempotency_key, reason_code, origin)
    VALUES ('11111111-1111-4111-8111-111111111111',
            ARRAY['aaaaaaaa-0000-4000-8000-000000000302']::uuid[], 'sale', 'MO-O2', 'MO-O2',
            'TXN-O2', 1.00, 'MO-O2', 'sale', 'gateway_verified_trust_me');
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  PERFORM public._expect('origin/unknown_origin_refused', refused,
    'an undefined origin value must be refused by payment_events_origin_known');
END;
$$;

-- ==================================================================================================
-- O3. A device amount check on a row that is NOT a device report is refused -- a server row cannot
--     be made to look like it was checked against a device's figure. (Mutation MO2 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_check_needs_device()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE refused boolean := false;
BEGIN
  PERFORM public._seed();
  BEGIN
    INSERT INTO public.payment_events
      (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
       transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
    VALUES ('11111111-1111-4111-8111-111111111111',
            ARRAY['aaaaaaaa-0000-4000-8000-000000000303']::uuid[], 'sale', 'MO-O3', 'MO-O3',
            'TXN-O3', 1.00, 'MO-O3', 'sale', 'gateway', 'matched_intent');
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  PERFORM public._expect('origin/check_on_non_device_refused', refused,
    'device_amount_check is only meaningful on origin=terminal_device');
END;
$$;

-- ==================================================================================================
-- O4. settle_order_payment's ledger row is unaffected by the new columns and stays recognisable as
--     server-verified (raw_gateway_response.recorded_by = server) -- the predicate
--     lib/payments/reconcile-reference.ts isServerVerifiedLedgerRow relies on.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_rpc_ledger_row()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; ev record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000304', '11111111-1111-4111-8111-111111111111',
          304, 'pending', 'pending', 100, 10000);

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000304']::uuid[],
    10000, 10000, 'TXN-O4', 'MO-O4', 'card', 'MO-O4', NULL,
    'staff_reconcile', NULL, 0, NULL, ARRAY[]::uuid[], NULL);

  SELECT * INTO ev FROM public.payment_events WHERE business_order_no = 'MO-O4';
  PERFORM public._expect('origin/rpc_ledger_row_written', (r->>'ok')::boolean AND ev.id IS NOT NULL,
    r::text);
  PERFORM public._expect('origin/rpc_ledger_row_server_recognisable',
    ev.raw_gateway_response->>'recorded_by' = 'server' AND ev.device_amount_check IS NULL,
    format('raw=%s', ev.raw_gateway_response));
END;
$$;

-- ==================================================================================================
-- O5. DEVICE FIRST, THEN THE VERIFIED SETTLEMENT. The device's row is not rewritten (history is
--     immutable), and the settlement still applies -- the orders are paid and the audit row says no
--     ledger row was written. This pins the merge point with the origin-discriminated ledger work:
--     the ONLY sale row for this reference is the device's report.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_device_first()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer; ev record; o record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000305', '11111111-1111-4111-8111-111111111111',
          305, 'pending', 'pending', 100, 10000);
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000305']::uuid[], 'sale', 'MO-O5', 'MO-O5',
          'TXN-O5', 1.00, 'MO-O5', 'sale', 'terminal_device', 'mismatch_order_totals');

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000305']::uuid[],
    10000, 10000, 'TXN-O5', 'MO-O5', 'card', 'MO-O5', NULL,
    'cron_reconcile_orphan_payments', NULL, 0, NULL, ARRAY[]::uuid[], NULL);

  SELECT count(*) INTO n FROM public.payment_events WHERE business_order_no = 'MO-O5';
  SELECT * INTO ev FROM public.payment_events WHERE business_order_no = 'MO-O5';
  SELECT * INTO o FROM public.orders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000305';
  PERFORM public._expect('origin/device_first_settles', (r->>'ok')::boolean AND o.payment_status = 'paid',
    r::text);
  PERFORM public._expect('origin/device_row_not_rewritten',
    n = 1 AND ev.origin = 'terminal_device' AND ev.amount = 1.00,
    format('rows=%s origin=%s amount=%s', n, ev.origin, ev.amount));
  PERFORM public._expect('origin/device_first_no_gateway_row', (r->>'ledger_row_written')::boolean = false,
    r::text);
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_origin_device_row',
    '_t_origin_unknown_refused',
    '_t_origin_check_needs_device',
    '_t_origin_rpc_ledger_row',
    '_t_origin_device_first'
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
