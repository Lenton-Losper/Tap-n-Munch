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
-- O3. A device amount check on a row with no device origin is refused -- a legacy/server row cannot
--     be made to look like it was checked against a device's figure. (Mutation MO2 must break this.)
--     Since 20260929130000 a PROMOTED row (origin='gateway') keeps the check it was recorded with,
--     so the probe uses origin NULL.
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
            'TXN-O3', 1.00, 'MO-O3', 'sale', NULL, 'matched_intent');
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
-- O5. DEVICE FIRST, THEN THE VERIFIED SETTLEMENT (20260929130000, lead ruling). The device's report
--     is PROMOTED in the same transaction: one row, origin='gateway', the verified amount and set,
--     the device's own figures preserved, one audit row with both. (MPR1 / MPR2 / MPR3 break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_device_first()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer; ev record; o record; aud record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000305', '11111111-1111-4111-8111-111111111111',
          305, 'pending', 'pending', 100, 10000);
  -- The device reported N$1 against a N$100 charge and named an order that is not in it.
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000999']::uuid[], 'sale', 'MO-O5', 'MO-O5',
          'TXN-O5', 1.00, 'MO-O5', 'sale', 'terminal_device', 'mismatch_order_totals');

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000305']::uuid[],
    10000, 10000, 'TXN-O5', 'MO-O5', 'card', 'MO-O5', NULL,
    'cron_reconcile_orphan_payments', NULL, 0, NULL, ARRAY[]::uuid[], NULL);

  SELECT count(*) INTO n FROM public.payment_events WHERE event_type = 'sale';
  SELECT * INTO ev FROM public.payment_events WHERE business_order_no = 'MO-O5';
  SELECT * INTO o FROM public.orders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000305';
  SELECT * INTO aud FROM public.audit_logs WHERE action = 'payment.device_row_promoted';

  PERFORM public._expect('origin/device_first_settles', (r->>'ok')::boolean AND o.payment_status = 'paid',
    r::text);
  PERFORM public._expect('origin/device_first_one_sale_row', n = 1, format('sale rows=%s', n));
  PERFORM public._expect('origin/device_first_promoted',
    ev.origin = 'gateway' AND (r->>'ledger_row_promoted')::boolean,
    format('origin=%s r=%s', ev.origin, r));
  PERFORM public._expect('origin/device_first_verified_amount',
    ev.amount = 100.00 AND ev.order_ids = ARRAY['aaaaaaaa-0000-4000-8000-000000000305']::uuid[],
    format('amount=%s order_ids=%s', ev.amount, ev.order_ids));
  PERFORM public._expect('origin/device_first_device_amount_preserved',
    (ev.raw_gateway_response->'promoted'->>'device_reported_amount')::numeric = 1.00
      AND ev.device_amount_check = 'mismatch_order_totals',
    format('raw=%s check=%s', ev.raw_gateway_response, ev.device_amount_check));
  PERFORM public._expect('origin/device_first_promotion_audited',
    aud.entity_id = ev.id::text
      AND (aud.metadata->>'device_reported_amount')::numeric = 1.00
      AND (aud.metadata->>'gateway_amount_cents')::integer = 10000,
    format('audit=%s', aud.metadata));
END;
$$;

-- ==================================================================================================
-- O6. GATEWAY FIRST, THEN THE DEVICE. The device's later insert hits the key and never overwrites.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_gateway_first()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer; ev record; refused boolean := false;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000306', '11111111-1111-4111-8111-111111111111',
          306, 'pending', 'pending', 100, 10000);
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000306']::uuid[],
    10000, 10000, 'TXN-O6', 'MO-O6', 'card', 'MO-O6', NULL,
    'paycloud_webhook', NULL, 0, NULL, ARRAY[]::uuid[], NULL);
  BEGIN
    INSERT INTO public.payment_events
      (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
       transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
    VALUES ('11111111-1111-4111-8111-111111111111',
            ARRAY['aaaaaaaa-0000-4000-8000-000000000306']::uuid[], 'sale', 'MO-O6', 'MO-O6',
            'TXN-O6', 5.00, 'MO-O6', 'sale', 'terminal_device', 'mismatch_order_totals');
  EXCEPTION WHEN unique_violation THEN
    refused := true;
  END;
  SELECT count(*) INTO n FROM public.payment_events WHERE event_type = 'sale';
  SELECT * INTO ev FROM public.payment_events WHERE business_order_no = 'MO-O6';
  PERFORM public._expect('origin/gateway_first_device_refused', refused);
  PERFORM public._expect('origin/gateway_first_not_overwritten',
    n = 1 AND ev.amount = 100.00 AND ev.origin IS NULL
      AND ev.raw_gateway_response->>'recorded_by' = 'server',
    format('rows=%s amount=%s origin=%s', n, ev.amount, ev.origin));
END;
$$;

-- ==================================================================================================
-- O7. The device's row carried the SAME transaction under a DIFFERENT reference: still one row per
--     transaction -- it is promoted, not joined by a second row (and the unique index never fires).
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_device_same_txn()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer; ev record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000307', '11111111-1111-4111-8111-111111111111',
          307, 'pending', 'pending', 100, 10000);
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000307']::uuid[], 'sale', 'DEVICE-REF', 'DEVICE-REF',
          'TXN-O7', 100.00, 'DEVICE-REF', 'sale', 'terminal_device', 'matched_order_totals');
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000307']::uuid[],
    10000, 10000, 'TXN-O7', 'MO-O7', 'card', 'MO-O7', NULL,
    'paycloud_webhook', NULL, 0, NULL, ARRAY[]::uuid[], NULL);
  SELECT count(*) INTO n FROM public.payment_events WHERE event_type = 'sale';
  SELECT * INTO ev FROM public.payment_events WHERE transaction_id = 'TXN-O7';
  PERFORM public._expect('origin/same_txn_one_row',
    (r->>'ok')::boolean AND n = 1 AND ev.origin = 'gateway',
    format('r=%s rows=%s origin=%s', r, n, ev.origin));
END;
$$;

-- ==================================================================================================
-- O8. A promoted row's refund cap is the VERIFIED amount (20260929130100 over 130000).
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_origin_promoted_refund_cap()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; state text;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000308', '11111111-1111-4111-8111-111111111111',
          308, 'pending', 'pending', 100, 10000);
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000308']::uuid[], 'sale', 'MO-O8', 'MO-O8',
          'TXN-O8', 500.00, 'MO-O8', 'sale', 'terminal_device', 'mismatch_order_totals');
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000308']::uuid[],
    10000, 10000, 'TXN-O8', 'MO-O8', 'card', 'MO-O8', NULL,
    'paycloud_webhook', NULL, 0, NULL, ARRAY[]::uuid[], NULL);
  BEGIN
    PERFORM public.record_terminal_refund_event(
      '11111111-1111-4111-8111-111111111111',
      ARRAY['aaaaaaaa-0000-4000-8000-000000000308']::uuid[], 'refund_succeeded', 'R-O8',
      'MO-O8', 'RTXN-O8', 'term-1', 100.01, 'NAD', 'refund-o8', NULL, 'refund', NULL, NULL, NULL);
    state := NULL;
  EXCEPTION WHEN OTHERS THEN
    state := SQLSTATE;
  END;
  PERFORM public._expect('origin/promoted_refund_capped_at_verified', state = 'P0003',
    format('the device said 500, the gateway 100; state=%s', state));
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
    '_t_origin_device_first',
    '_t_origin_gateway_first',
    '_t_origin_device_same_txn',
    '_t_origin_promoted_refund_cap'
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
