-- DATABASE TESTS for transfer_terminal_device() (20260930200000).
--
-- Run by supabase/tests/run-device-transfer-tests.mjs against a THROWAWAY local Postgres it starts
-- and names itself. Each test seeds its own rows and every assertion is counted into
-- _test_results, so "nothing ran" can never read as "everything passed".

CREATE TABLE IF NOT EXISTS public._test_results (
  name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text
);
DELETE FROM public._test_results;

-- A NULL assertion is a FAILED assertion (see settlement-rpc.test.sql for why this coalesce exists).
CREATE OR REPLACE FUNCTION public._expect(p_name text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := COALESCE(p_ok, false);
BEGIN
  INSERT INTO public._test_results (name, passed, detail)
  VALUES (p_name, v_ok, p_detail)
  ON CONFLICT (name) DO UPDATE SET passed = EXCLUDED.passed, detail = EXCLUDED.detail;
  IF NOT v_ok THEN
    RAISE WARNING 'FAIL % -- %', p_name, COALESCE(p_detail, '(no detail)');
  END IF;
END;
$$;

-- Restaurants A (the device's old home), B (the new one), C (an unrelated venue with its own P5).
-- Fixed ids so every test can name rows directly.
CREATE OR REPLACE FUNCTION public._dt_seed()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.audit_logs;
  DELETE FROM public.terminal_payment_intents;
  DELETE FROM public.restaurant_terminals;
  DELETE FROM public.restaurants WHERE id IN (
    'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
    'cccccccc-0000-4000-8000-000000000003');

  INSERT INTO public.restaurants (id, name) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001', 'Digi Cofee'),
    ('bbbbbbbb-0000-4000-8000-000000000002', 'FNB ChowNow'),
    ('cccccccc-0000-4000-8000-000000000003', 'Unrelated Venue');

  -- A's till, holding the physical device, with a live session.
  INSERT INTO public.restaurant_terminals
    (id, restaurant_id, device_id, device_serial, sn, status, active, activated_at,
     refresh_token_hash, refresh_token_expires_at, app_version, terminal_name)
  VALUES
    ('a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001',
     'dev-6799', 'dev-6799', 'WPHK-OLD', 'active', true, now() - interval '1 day',
     'old-refresh-hash', now() + interval '30 days', '2.40', 'Front till');

  -- B's pending code row: the device asked, and an authorized B user approved THIS device.
  INSERT INTO public.restaurant_terminals
    (id, restaurant_id, status, active, activation_code, activation_code_expires_at,
     transfer_request_device_id, transfer_requested_at, transfer_approved_at, transfer_approved_by,
     terminal_name)
  VALUES
    ('b0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002',
     'pending', false, 'FT-AAAA-BBBB', now() + interval '1 hour',
     'dev-6799', now() - interval '2 minutes', now() - interval '1 minute',
     'dddddddd-0000-4000-8000-00000000000d', 'New Terminal');

  -- C's own, unrelated P5. Must never change.
  INSERT INTO public.restaurant_terminals
    (id, restaurant_id, device_id, device_serial, status, active, activated_at,
     refresh_token_hash, refresh_token_expires_at, terminal_name)
  VALUES
    ('c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000003',
     'dev-other', 'dev-other', 'active', true, now() - interval '3 days',
     'c-refresh-hash', now() + interval '30 days', 'Bar till');

  -- Payment history attributed to A's till. The transfer must not touch it.
  INSERT INTO public.terminal_payment_intents
    (restaurant_id, terminal_id, merchant_order_no, amount_cents, scope, order_ids, status)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'FT-HISTORY-1',
          3400, 'orders', ARRAY['eeeeeeee-0000-4000-8000-00000000000e']::uuid[], 'confirmed');
END;
$$;

CREATE OR REPLACE FUNCTION public._dt_transfer(p_code uuid, p_device text DEFAULT 'dev-6799')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.transfer_terminal_device(p_code, p_device, p_device, 'WPHK-NEW', 'new-refresh-hash', now() + interval '30 days');
$$;

CREATE OR REPLACE FUNCTION public._dt_holders(p_device text DEFAULT 'dev-6799')
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.restaurant_terminals WHERE device_id = p_device OR device_serial = p_device;
$$;

-- ------------------------------------------------------------------------------------------------
-- J/K/L/M: an approved transfer moves the device, releases A, kills A's session, audits both.
-- ------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r jsonb;
  a public.restaurant_terminals%ROWTYPE;
  b public.restaurant_terminals%ROWTYPE;
  c public.restaurant_terminals%ROWTYPE;
  intents_before int;
BEGIN
  PERFORM public._dt_seed();
  SELECT count(*) INTO intents_before FROM public.terminal_payment_intents;
  -- A transfer that THROWS must fail these assertions, not abort the suite: an escaped error
  -- would stop psql, and every later test would simply never be counted.
  BEGIN
    r := public._dt_transfer('b0000000-0000-4000-8000-00000000000b');
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error', SQLERRM);
  END;

  SELECT * INTO a FROM public.restaurant_terminals WHERE id = 'a0000000-0000-4000-8000-00000000000a';
  SELECT * INTO b FROM public.restaurant_terminals WHERE id = 'b0000000-0000-4000-8000-00000000000b';
  SELECT * INTO c FROM public.restaurant_terminals WHERE id = 'c0000000-0000-4000-8000-00000000000c';

  PERFORM public._expect('transfer/returns_new_terminal', r->>'terminalId' = 'b0000000-0000-4000-8000-00000000000b', r::text);
  PERFORM public._expect('transfer/released_count_1', (r->>'releasedCount')::int = 1, r::text);

  PERFORM public._expect('transfer/new_row_active', b.status = 'active' AND b.active = true, b.status);
  PERFORM public._expect('transfer/new_row_has_identity', b.device_id = 'dev-6799' AND b.device_serial = 'dev-6799', b.device_id);
  PERFORM public._expect('transfer/new_row_session', b.refresh_token_hash = 'new-refresh-hash', b.refresh_token_hash);
  PERFORM public._expect('transfer/code_consumed', b.activation_code IS NULL AND b.activation_code_expires_at IS NULL, b.activation_code);
  PERFORM public._expect('transfer/approval_cleared', b.transfer_approved_at IS NULL AND b.transfer_request_device_id IS NULL, NULL);

  PERFORM public._expect('transfer/old_row_identity_released', a.device_id IS NULL AND a.device_serial = 'ft-' || a.id::text, a.device_serial);
  PERFORM public._expect('transfer/old_row_session_invalidated', a.refresh_token_hash IS NULL AND a.refresh_token_expires_at IS NULL, a.refresh_token_hash);
  PERFORM public._expect('transfer/old_row_revoked', a.status = 'revoked' AND a.active = false, a.status);
  PERFORM public._expect('transfer/old_row_kept_for_history', a.id IS NOT NULL AND a.restaurant_id = 'aaaaaaaa-0000-4000-8000-000000000001', NULL);

  PERFORM public._expect('transfer/exactly_one_holder', public._dt_holders() = 1, public._dt_holders()::text);

  PERFORM public._expect('transfer/audit_out_in_old_restaurant',
    EXISTS (SELECT 1 FROM public.audit_logs WHERE restaurant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
              AND action = 'terminal.device_transferred_out' AND entity_id = 'a0000000-0000-4000-8000-00000000000a'), NULL);
  PERFORM public._expect('transfer/audit_in_new_restaurant',
    EXISTS (SELECT 1 FROM public.audit_logs WHERE restaurant_id = 'bbbbbbbb-0000-4000-8000-000000000002'
              AND action = 'terminal.device_transferred_in' AND entity_id = 'b0000000-0000-4000-8000-00000000000b'), NULL);
  PERFORM public._expect('transfer/old_restaurant_audit_does_not_name_new_restaurant',
    NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE restaurant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
                  AND metadata::text LIKE '%bbbbbbbb%'), NULL);

  PERFORM public._expect('transfer/unrelated_terminal_untouched',
    c.device_id = 'dev-other' AND c.status = 'active' AND c.refresh_token_hash = 'c-refresh-hash', c.status);
  PERFORM public._expect('transfer/payment_history_untouched',
    (SELECT count(*) FROM public.terminal_payment_intents
      WHERE terminal_id = 'a0000000-0000-4000-8000-00000000000a' AND status = 'confirmed' AND amount_cents = 3400) = 1
    AND (SELECT count(*) FROM public.terminal_payment_intents) = intents_before, NULL);
END $$;

-- ------------------------------------------------------------------------------------------------
-- Refusals. Each must raise AND change nothing.
-- ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._dt_refused(p_name text, p_expected text, p_setup text, p_device text DEFAULT 'dev-6799')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_msg text := NULL;
  a_before text;
  a_after text;
BEGIN
  PERFORM public._dt_seed();
  IF p_setup IS NOT NULL THEN EXECUTE p_setup; END IF;
  SELECT row_to_json(t)::text INTO a_before FROM public.restaurant_terminals t WHERE id = 'a0000000-0000-4000-8000-00000000000a';
  BEGIN
    PERFORM public._dt_transfer('b0000000-0000-4000-8000-00000000000b', p_device);
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  SELECT row_to_json(t)::text INTO a_after FROM public.restaurant_terminals t WHERE id = 'a0000000-0000-4000-8000-00000000000a';
  PERFORM public._expect('refused/' || p_name || '/raises_' || p_expected, v_msg = p_expected, coalesce(v_msg, '(no error)'));
  PERFORM public._expect('refused/' || p_name || '/old_row_unchanged', a_before = a_after, NULL);
  PERFORM public._expect('refused/' || p_name || '/no_audit', NOT EXISTS (SELECT 1 FROM public.audit_logs), NULL);
END;
$$;

SELECT public._dt_refused('not_approved', 'TRANSFER_NOT_APPROVED',
  $s$UPDATE public.restaurant_terminals SET transfer_approved_at = NULL WHERE id = 'b0000000-0000-4000-8000-00000000000b'$s$);
SELECT public._dt_refused('approved_for_another_device', 'TRANSFER_NOT_APPROVED', NULL, 'dev-imposter');
SELECT public._dt_refused('expired_code', 'TRANSFER_CODE_INVALID',
  $s$UPDATE public.restaurant_terminals SET activation_code_expires_at = now() - interval '1 second' WHERE id = 'b0000000-0000-4000-8000-00000000000b'$s$);
SELECT public._dt_refused('used_code', 'TRANSFER_CODE_INVALID',
  $s$UPDATE public.restaurant_terminals SET active = true WHERE id = 'b0000000-0000-4000-8000-00000000000b'$s$);
SELECT public._dt_refused('no_code', 'TRANSFER_CODE_INVALID',
  $s$UPDATE public.restaurant_terminals SET activation_code = NULL WHERE id = 'b0000000-0000-4000-8000-00000000000b'$s$);
SELECT public._dt_refused('same_restaurant_holder', 'TRANSFER_SAME_RESTAURANT',
  $s$UPDATE public.restaurant_terminals SET restaurant_id = 'bbbbbbbb-0000-4000-8000-000000000002' WHERE id = 'a0000000-0000-4000-8000-00000000000a'$s$);

-- ------------------------------------------------------------------------------------------------
-- G: the same device can move again -- B back to A with A's own approved code.
-- ------------------------------------------------------------------------------------------------
DO $$
DECLARE
  back public.restaurant_terminals%ROWTYPE;
  b public.restaurant_terminals%ROWTYPE;
BEGIN
  PERFORM public._dt_seed();
  BEGIN
    PERFORM public._dt_transfer('b0000000-0000-4000-8000-00000000000b');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- the assertions below then fail on the state it left
  END;
  INSERT INTO public.restaurant_terminals
    (id, restaurant_id, status, active, activation_code, activation_code_expires_at,
     transfer_request_device_id, transfer_requested_at, transfer_approved_at)
  VALUES ('a1111111-0000-4000-8000-00000000001a', 'aaaaaaaa-0000-4000-8000-000000000001', 'pending', false,
          'FT-BACK-HOME', now() + interval '1 hour', 'dev-6799', now(), now());
  BEGIN
    PERFORM public._dt_transfer('a1111111-0000-4000-8000-00000000001a');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT * INTO back FROM public.restaurant_terminals WHERE id = 'a1111111-0000-4000-8000-00000000001a';
  SELECT * INTO b FROM public.restaurant_terminals WHERE id = 'b0000000-0000-4000-8000-00000000000b';
  PERFORM public._expect('transfer_back/device_home_again', back.device_id = 'dev-6799' AND back.status = 'active', back.status);
  PERFORM public._expect('transfer_back/b_released', b.device_id IS NULL AND b.refresh_token_hash IS NULL AND b.status = 'revoked', b.status);
  PERFORM public._expect('transfer_back/one_holder', public._dt_holders() = 1, public._dt_holders()::text);
END $$;

-- ------------------------------------------------------------------------------------------------
-- Grants: service_role only, with a positive control.
-- ------------------------------------------------------------------------------------------------
DO $$
DECLARE
  sig text := 'public.transfer_terminal_device(uuid, text, text, text, text, timestamptz)';
BEGIN
  PERFORM public._expect('grants/exists', to_regprocedure(sig) IS NOT NULL, sig);
  PERFORM public._expect('grants/anon_cannot_execute', NOT has_function_privilege('anon', sig, 'EXECUTE'), 'anon can execute');
  PERFORM public._expect('grants/authenticated_cannot_execute', NOT has_function_privilege('authenticated', sig, 'EXECUTE'), 'authenticated can execute');
  PERFORM public._expect('grants/service_role_can_execute', has_function_privilege('service_role', sig, 'EXECUTE'), 'service_role lost execute');
END $$;

-- The unique indexes are the last line of defence against two owners. Assert they exist, so a
-- mutation (or a future migration) that drops them is caught here and not in production.
SELECT public._expect('constraints/device_id_unique',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_terminals_device_id_unique'), NULL);
SELECT public._expect('constraints/device_serial_unique',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_terminals_device_serial_unique'), NULL);
