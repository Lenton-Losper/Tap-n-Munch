-- DATABASE TESTS: a card charge settles against the SAME version of the order it was prepared on
-- (Sprint 2026-09-29 brief, task 5 -- 20260929120000 / 120100 / 120200).
--
-- Run by supabase/tests/run-db-tests.mjs AFTER settlement-rpc.test.sql and amend-rpc.test.sql, in
-- the same throwaway database: reuses `_test_results`, `_expect()`, `_seed_amend()`, `_amend()` and
-- `_line_state()`. Never against a real database -- these tests INSERT.
--
-- The fixture is amend-rpc's order #160: N$400, three lines (pasta + lager outstanding, steak
-- cooked). "A guest edit" is what the guest editor writes -- items and total on the order row, the
-- only writer of either column on an existing order. "Preparing a charge" is what prepare-payment
-- writes -- pending_charge_cents (plus, from a route that read first, pending_charge_read_basis).
--
-- The two-session versions of the races live in charge-edit-race.test.sh.

CREATE OR REPLACE FUNCTION public._cr_order() RETURNS uuid LANGUAGE sql AS $$
  SELECT 'bbbbbbbb-0000-4000-8000-000000000160'::uuid
$$;

CREATE OR REPLACE FUNCTION public._cr_prepare(p_cents integer)
RETURNS void LANGUAGE sql AS $$
  UPDATE public.orders
     SET pending_charge_cents = p_cents,
         pending_settlement_id = '44444444-4444-4444-8444-444444444160'
   WHERE id = public._cr_order();
$$;

-- The device went quiet: the prepared charge is older than the in-flight window.
CREATE OR REPLACE FUNCTION public._cr_expire_window()
RETURNS void LANGUAGE sql AS $$
  UPDATE public.orders SET pending_charge_at = now() - interval '10 minutes'
   WHERE id = public._cr_order();
$$;

-- The guest adds a N$50 dessert. Returns the SQLSTATE it raised, or 'ok'.
CREATE OR REPLACE FUNCTION public._cr_guest_edit()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.orders
     SET items = items || '[{"name":"Dessert","quantity":1,"price":50,"subtotal":43.48,"tax":6.52,"total":50}]'::jsonb,
         total = total + 50
   WHERE id = public._cr_order();
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;

-- The gateway confirmed p_cents for order #160. An exception is RETURNED as a refusal so the
-- assertions after it still run (a raise would roll back the test and hide them).
CREATE OR REPLACE FUNCTION public._cr_settle(p_cents integer, p_ref text DEFAULT 'MO-CR')
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111', ARRAY[public._cr_order()],
    p_cents, p_cents, 'TXN-' || p_ref, p_ref, 'card', p_ref, NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.39');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'raised:' || SQLSTATE, 'message', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public._cr_status() RETURNS text LANGUAGE sql AS $$
  SELECT payment_status FROM public.orders WHERE id = public._cr_order()
$$;

-- ==================================================================================================
-- CR1. The basis is stamped with the charge and released with it.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_stamp()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  PERFORM public._expect('basis/stamped_when_charge_prepared',
    o.pending_charge_basis = public.order_charge_basis(o.id, o.total, o.items)
      AND o.pending_charge_at IS NOT NULL AND o.pending_charge_read_basis IS NULL,
    format('basis=%s at=%s', o.pending_charge_basis, o.pending_charge_at));

  UPDATE public.orders SET pending_charge_cents = NULL WHERE id = public._cr_order();
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  PERFORM public._expect('basis/cleared_when_released',
    o.pending_charge_basis IS NULL AND o.pending_charge_at IS NULL,
    format('basis=%s at=%s', o.pending_charge_basis, o.pending_charge_at));
END;
$$;

-- ==================================================================================================
-- CR2. (A) A guest edit while the charge is in flight is REFUSED; the charge then settles at the
--      figure the order still has. (Mutation MR1 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_inflight_edit_refused()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text; r jsonb; o record;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  s := public._cr_guest_edit();
  PERFORM public._expect('inflight_edit/refused_ftinf', s = 'FTINF', s);
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  PERFORM public._expect('inflight_edit/total_unchanged', o.total = 400,
    format('total=%s', o.total));

  r := public._cr_settle(40000);
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  -- THE INVARIANT: paid, and the figure charged is the figure the order is worth.
  PERFORM public._expect('inflight_edit/settled_at_the_order_figure',
    (r->>'ok')::boolean AND o.payment_status = 'paid' AND round(o.total * 100) = 40000,
    r::text || ' total=' || o.total);
END;
$$;

-- Negative control: no charge prepared, so the guest may edit.
CREATE OR REPLACE FUNCTION public._t_cr_edit_without_charge()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  PERFORM public._seed_amend();
  s := public._cr_guest_edit();
  PERFORM public._expect('no_charge/edit_allowed', s = 'ok', s);
END;
$$;

-- ==================================================================================================
-- CR3. (B) The window lapsed, the guest edited, and THEN the gateway confirmed the old figure.
--      The settlement is HELD and recorded, never applied. (Mutations MR2 / MR2b must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_changed_settlement_held()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text; r jsonb; n integer; a record;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  s := public._cr_guest_edit();
  PERFORM public._expect('changed_held/late_edit_allowed', s = 'ok', s);

  r := public._cr_settle(40000);
  PERFORM public._expect('changed_held/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('changed_held/reason',
    r->>'reason' = 'order_changed_since_preparation', r::text);
  PERFORM public._expect('changed_held/nothing_paid', public._cr_status() <> 'paid',
    'order paid at N$400 while it now totals N$450: ' || r::text);
  PERFORM public._expect('changed_held/order_held', public._cr_status() = 'amount_mismatch_hold',
    public._cr_status());

  SELECT count(*)::integer AS n,
         min((metadata->>'orderChargeCents')::integer) AS charged,
         min((metadata->>'orderTotalCentsNow')::integer) AS now_total
    INTO a
    FROM public.audit_logs WHERE action = 'payment.held_order_changed_since_charge_prepared';
  PERFORM public._expect('changed_held/evidence_recorded',
    a.n = 1 AND a.charged = 40000 AND a.now_total = 45000, format('%s', row_to_json(a)));
  SELECT count(*) INTO n FROM public.audit_logs WHERE action = 'payment.settlement_held_order_changed';
  PERFORM public._expect('changed_held/settlement_row', n = 1, format('%s rows', n));
  SELECT count(*) INTO n FROM public.payment_events;
  PERFORM public._expect('changed_held/no_ledger_row', n = 0, format('%s ledger rows', n));

  -- A retried confirmation: still refused, no second evidence row.
  r := public._cr_settle(40000);
  SELECT count(*) INTO n FROM public.audit_logs
   WHERE action IN ('payment.held_order_changed_since_charge_prepared',
                    'payment.settlement_held_order_changed');
  PERFORM public._expect('changed_held/replay_refused_without_duplicate_evidence',
    (r->>'ok')::boolean IS FALSE AND n = 2 AND public._cr_status() <> 'paid',
    format('%s evidence rows, %s', n, r));
END;
$$;

-- ==================================================================================================
-- CR4. The STAFF direction: a line voided mid-charge. Within the window amend refuses it (A); after
--      it, the void lands and the late settlement is held (B). (MR5 / MR6 must break these.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_amend_inflight_refused()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]');
  PERFORM public._expect('amend_inflight/refused',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000001') = 'payment_in_flight'
      AND jsonb_array_length(r->'applied') = 0, r::text);
  PERFORM public._expect('amend_inflight/line_untouched',
    public._line_state('cccccccc-0000-4000-8000-000000000001') = 'outstanding/-',
    public._line_state('cccccccc-0000-4000-8000-000000000001'));
  SELECT count(*) INTO n FROM public.orders WHERE order_number = 900;
  PERFORM public._expect('amend_inflight/no_replacement_order', n = 0, format('%s', n));
END;
$$;

CREATE OR REPLACE FUNCTION public._t_cr_void_settlement_held()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]');
  PERFORM public._expect('void_held/late_void_applied',
    jsonb_array_length(r->'applied') = 1, r::text);

  -- The card was charged N$400; the order is now worth N$160.
  r := public._cr_settle(40000);
  PERFORM public._expect('void_held/reason',
    r->>'reason' = 'order_changed_since_preparation', r::text);
  PERFORM public._expect('void_held/nothing_paid', public._cr_status() <> 'paid',
    'order paid N$400 for N$160 of live food: ' || r::text);
END;
$$;

-- Negative controls: things that are NOT a change to what is being charged.
CREATE OR REPLACE FUNCTION public._t_cr_not_a_change()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; s text;
BEGIN
  -- The kitchen moves lines along mid-charge.
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  UPDATE public.order_lines SET bar_state = 'ready' WHERE id = 'cccccccc-0000-4000-8000-000000000002';
  UPDATE public.order_lines SET kitchen_state = 'cooked' WHERE id = 'cccccccc-0000-4000-8000-000000000001';
  r := public._cr_settle(40000);
  PERFORM public._expect('not_a_change/kitchen_progress_settles',
    (r->>'ok')::boolean AND public._cr_status() = 'paid', r::text);

  -- A re-preparation after the edit re-bases the charge: the NEW figure settles.
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  s := public._cr_guest_edit();
  PERFORM public._cr_prepare(45000);
  r := public._cr_settle(45000, 'MO-CR2');
  PERFORM public._expect('not_a_change/reprepared_charge_settles',
    s = 'ok' AND (r->>'ok')::boolean AND public._cr_status() = 'paid', s || ' ' || r::text);
END;
$$;

-- ==================================================================================================
-- CR5. prepare-payment's read -> write window. The figure was computed from a read; if the order
--      moved before the expectation is written, the write is refused. (MR4 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_prepare_read_basis()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE b text; s text; o record;
BEGIN
  PERFORM public._seed_amend();
  SELECT public.charge_basis(x) INTO b FROM public.orders x WHERE x.id = public._cr_order();
  PERFORM public._cr_guest_edit();   -- nothing prepared yet, so allowed
  BEGIN
    UPDATE public.orders SET pending_charge_cents = 40000, pending_charge_read_basis = b
     WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  PERFORM public._expect('prepare_read/stale_read_refused',
    s = 'FTCHG' AND o.pending_charge_cents IS NULL, s || ' pending=' || COALESCE(o.pending_charge_cents::text, 'null'));

  SELECT public.charge_basis(x) INTO b FROM public.orders x WHERE x.id = public._cr_order();
  UPDATE public.orders SET pending_charge_cents = 45000, pending_charge_read_basis = b
   WHERE id = public._cr_order();
  SELECT * INTO o FROM public.orders WHERE id = public._cr_order();
  PERFORM public._expect('prepare_read/fresh_read_accepted',
    o.pending_charge_cents = 45000 AND o.pending_charge_basis = b AND o.pending_charge_read_basis IS NULL,
    format('%s %s', o.pending_charge_cents, o.pending_charge_read_basis));
END;
$$;

-- ==================================================================================================
-- CR6. (C) Every OTHER paid-writer (markOrderPaidConfirmed's plain UPDATE) is refused the same way.
--      Cash and a human resolving a hold are not. (MR3 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_cr_paid_guard()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  PERFORM public._cr_guest_edit();
  BEGIN
    UPDATE public.orders SET payment_status = 'paid', payment_method = 'card', status = 'completed'
     WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/card_refused', s = 'FTCHG' AND public._cr_status() = 'pending',
    s || ' ' || public._cr_status());

  BEGIN
    UPDATE public.orders SET payment_status = 'paid', payment_method = 'cash' WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/cash_allowed', s = 'ok' AND public._cr_status() = 'paid', s);

  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  PERFORM public._cr_guest_edit();
  UPDATE public.orders SET payment_status = 'amount_mismatch_hold' WHERE id = public._cr_order();
  BEGIN
    UPDATE public.orders SET payment_status = 'paid', payment_method = 'card' WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/hold_resolution_allowed', s = 'ok', s);

  -- PayToday is not a gateway charge (f-manual's tab settle claim).
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  PERFORM public._cr_guest_edit();
  BEGIN
    UPDATE public.orders SET payment_status = 'paid', payment_method = 'paytoday' WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/paytoday_allowed', s = 'ok' AND public._cr_status() = 'paid', s);

  -- Mark-as-Paid on a standalone card machine states what it collected from the live figure.
  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  PERFORM public._cr_expire_window();
  PERFORM public._cr_guest_edit();
  BEGIN
    UPDATE public.orders
       SET payment_status = 'paid', payment_method = 'card', settled_charge_cents = 45000
     WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/explicit_live_figure_allowed', s = 'ok' AND public._cr_status() = 'paid', s);

  PERFORM public._seed_amend();
  PERFORM public._cr_prepare(40000);
  BEGIN
    UPDATE public.orders SET payment_status = 'paid', payment_method = 'card' WHERE id = public._cr_order();
    s := 'ok';
  EXCEPTION WHEN OTHERS THEN s := SQLSTATE;
  END;
  PERFORM public._expect('paid_guard/unchanged_order_allowed', s = 'ok', s);
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_cr_stamp',
    '_t_cr_inflight_edit_refused',
    '_t_cr_edit_without_charge',
    '_t_cr_changed_settlement_held',
    '_t_cr_amend_inflight_refused',
    '_t_cr_void_settlement_held',
    '_t_cr_not_a_change',
    '_t_cr_prepare_read_basis',
    '_t_cr_paid_guard'
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
