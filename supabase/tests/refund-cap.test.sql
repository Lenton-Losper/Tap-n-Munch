-- DATABASE TESTS for 20260929130100_refund_cap_is_verified_amount.sql.
--
-- record_terminal_refund_event caps refund_succeeded at a VERIFIED figure: a verified sale's amount,
-- the intent's amount for a device row, a device row that matched; an unverified device row is
-- refused. Reuses settlement-rpc.test.sql's _test_results / _expect / _seed. Throwaway DB only.

CREATE OR REPLACE FUNCTION public._refund_sale(p_ref text, p_amount numeric, p_origin text,
  p_check text, p_raw jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check,
     raw_gateway_response)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000401']::uuid[], 'sale', p_ref, p_ref,
          'TXN-' || p_ref, p_amount, p_ref, 'sale', p_origin, p_check, p_raw);
END;
$$;

-- Returns NULL on success, else the SQLSTATE of the refusal.
CREATE OR REPLACE FUNCTION public._refund(p_ref text, p_amount numeric, p_key text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.record_terminal_refund_event(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000401']::uuid[], 'refund_succeeded', 'R-' || p_key,
    p_ref, 'RTXN-' || p_key, 'term-1', p_amount, 'NAD', p_key, NULL, 'refund', NULL, NULL, NULL);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;

CREATE OR REPLACE FUNCTION public._t_refund_verified_sale()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  PERFORM public._refund_sale('MO-R1', 100, NULL, NULL, '{"recorded_by":"server"}'::jsonb);
  PERFORM public._expect('refund/verified_full_amount_ok', public._refund('MO-R1', 60, 'k1') IS NULL);
  PERFORM public._expect('refund/verified_over_cap_refused',
    public._refund('MO-R1', 40.01, 'k2') = 'P0003', 'remaining is 40.00');
END;
$$;

-- A device row that over-reported N$500 against a N$100 intent. (Mutation MR1 must break this.)
CREATE OR REPLACE FUNCTION public._t_refund_device_intent_cap()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  INSERT INTO public.terminal_payment_intents
    (restaurant_id, merchant_order_no, amount_cents, scope, order_ids)
  VALUES ('11111111-1111-4111-8111-111111111111', 'MO-R2', 10000, 'orders',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000401']::uuid[]);
  PERFORM public._refund_sale('MO-R2', 500, 'terminal_device', 'mismatch_intent', NULL);
  PERFORM public._expect('refund/device_capped_at_intent',
    public._refund('MO-R2', 150, 'k3') = 'P0003', 'the device said 500; the intent says 100');
  PERFORM public._expect('refund/device_intent_amount_ok', public._refund('MO-R2', 100, 'k4') IS NULL);
END;
$$;

-- No intent, amount did not match: no verified figure. (Mutation MR2 must break this.)
CREATE OR REPLACE FUNCTION public._t_refund_device_unverified()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  PERFORM public._refund_sale('MO-R3', 500, 'terminal_device', 'mismatch_order_totals', NULL);
  PERFORM public._expect('refund/device_unverified_refused',
    public._refund('MO-R3', 1, 'k5') = 'P0001');
END;
$$;

CREATE OR REPLACE FUNCTION public._t_refund_device_matched_and_legacy()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  PERFORM public._refund_sale('MO-R4', 100, 'terminal_device', 'matched_order_totals', NULL);
  PERFORM public._expect('refund/device_matched_ok', public._refund('MO-R4', 100, 'k6') IS NULL);
  PERFORM public._refund_sale('MO-R5', 100, NULL, NULL, NULL);
  PERFORM public._expect('refund/legacy_unchanged', public._refund('MO-R5', 100, 'k7') IS NULL);
  PERFORM public._expect('refund/legacy_over_cap_refused', public._refund('MO-R5', 0.01, 'k8') = 'P0003');
END;
$$;

CREATE OR REPLACE FUNCTION public._t_refund_grants()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE sig text := 'public.record_terminal_refund_event(uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text)';
BEGIN
  PERFORM public._expect('refund/service_role_can_execute', has_function_privilege('service_role', sig, 'EXECUTE'));
  PERFORM public._expect('refund/anon_cannot_execute', NOT has_function_privilege('anon', sig, 'EXECUTE'));
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_refund_verified_sale',
    '_t_refund_device_intent_cap',
    '_t_refund_device_unverified',
    '_t_refund_device_matched_and_legacy',
    '_t_refund_grants'
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
