-- DATABASE / RPC TESTS for settle_order_payment() and the integrity constraints.
--
-- Run by supabase/tests/run-db-tests.mjs against a THROWAWAY local Postgres. Never against a real
-- database: the runner refuses any host that is not 127.0.0.1/localhost, and these tests INSERT.
--
-- Each test is one function that runs inside its own subtransaction and undoes itself, so the
-- tests are order-independent and a failure does not cascade. Every assertion is counted into
-- `_test_results`, because a suite that discovers nothing and a suite that passes everything
-- produce the same exit code otherwise -- "0 tests passed" is not success.

CREATE TABLE IF NOT EXISTS public._test_results (
  name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text
);
DELETE FROM public._test_results;

-- One helper so a failure reports WHAT disagreed rather than only that something did.
CREATE OR REPLACE FUNCTION public._expect(p_name text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  /**
   * A NULL ASSERTION IS A FAILED ASSERTION, NEVER AN ERROR.
   *
   * This coalesce is load-bearing and was added after the mutation harness caught its absence.
   * `SELECT * INTO rec ... ` that matches no row leaves `rec.col` NULL, so `rec.col = 720`
   * evaluates to NULL rather than false. Inserting NULL into `passed boolean NOT NULL` threw, the
   * whole test function's subtransaction rolled back -- taking every result it had already
   * recorded with it -- and the run reported only `<test>/threw`.
   *
   * The effect was that mutations M1, M2 and M4 DID break the code, and the assertions written to
   * catch them vanished from the results instead of appearing as failures. A suite that erases its
   * own findings when the code is broken is worse than one that has none.
   */
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

-- Fresh, deterministic fixture data. Called at the start of every test.
CREATE OR REPLACE FUNCTION public._seed()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.payment_tips;
  DELETE FROM public.audit_logs;
  DELETE FROM public.payment_events;
  DELETE FROM public.order_line_allocation_settlements;
  DELETE FROM public.order_line_allocations;
  DELETE FROM public.order_lines;
  DELETE FROM public.terminal_payment_intents;
  DELETE FROM public.orders;
  DELETE FROM public.tabs;
  DELETE FROM public.users;
  DELETE FROM public.restaurants;

  INSERT INTO public.restaurants (id, name) VALUES
    ('11111111-1111-4111-8111-111111111111', 'Riviera'),
    ('99999999-9999-4999-8999-999999999999', 'Other Venue');
  INSERT INTO public.users (id, email) VALUES
    ('55555555-5555-4555-8555-555555555555', 'waiter@example.test');
  INSERT INTO public.tabs (id, restaurant_id, total) VALUES
    ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 720);
END;
$$;

-- The exact Riviera pair: #154 N$220 and #155 N$500, one settlement, both payment_method 'cash'
-- (which is how an order that had a cash attempt before the card one is left).
CREATE OR REPLACE FUNCTION public._seed_riviera(p_tip_cents integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, tab_id, order_number, status, payment_status, payment_method, total,
     pending_charge_cents, pending_tip_cents, pending_tip_staff_user_id, pending_settlement_id)
  VALUES
    ('aaaaaaaa-0000-4000-8000-000000000154', '11111111-1111-4111-8111-111111111111',
     '22222222-2222-4222-8222-222222222222', 154, 'pending', 'pending', 'cash', 220,
     22000, 0, NULL, '44444444-4444-4444-8444-444444444444'),
    ('aaaaaaaa-0000-4000-8000-000000000155', '11111111-1111-4111-8111-111111111111',
     '22222222-2222-4222-8222-222222222222', 155, 'pending', 'pending', 'cash', 500,
     50000 + p_tip_cents, p_tip_cents,
     CASE WHEN p_tip_cents > 0 THEN '55555555-5555-4555-8555-555555555555'::uuid ELSE NULL END,
     '44444444-4444-4444-8444-444444444444');
END;
$$;

-- ==================================================================================================
-- T1. THE RIVIERA CASE. N$720 across two orders -> BOTH paid. (Mutation M1 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_riviera_multi_order()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  n_paid integer;
  n_events integer;
  ev record;
  aud record;
BEGIN
  PERFORM public._seed_riviera();

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-RIV-1', 'MO-RIV-1', 'card', 'MO-RIV-1', NULL,
    'paycloud_webhook_fallback_finatic_verified', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('riviera/rpc_ok', (r->>'ok')::boolean, r::text);

  SELECT count(*) INTO n_paid FROM public.orders WHERE payment_status = 'paid';
  -- THE ASSERTION THE OLD CODE FAILS. At 3a58efce only #155 was written: 1, not 2.
  PERFORM public._expect('riviera/both_orders_paid', n_paid = 2,
    format('expected 2 paid orders, found %s', n_paid));

  -- BOTH named individually, not only counted. A count of 2 would also be satisfied by paying
  -- two of three, and naming them is what makes the assertion say which order was dropped.
  PERFORM public._expect('riviera/order_154_paid',
    EXISTS (SELECT 1 FROM public.orders
             WHERE id = 'aaaaaaaa-0000-4000-8000-000000000154' AND payment_status = 'paid'),
    'order #154 -- the N$220 sibling the webhook dropped -- is still unpaid');
  PERFORM public._expect('riviera/order_155_paid',
    EXISTS (SELECT 1 FROM public.orders
             WHERE id = 'aaaaaaaa-0000-4000-8000-000000000155' AND payment_status = 'paid'),
    'order #155 -- the lead order -- is not paid');

  -- F3. Both orders carried payment_method 'cash' before the charge.
  PERFORM public._expect('riviera/method_is_card',
    NOT EXISTS (SELECT 1 FROM public.orders WHERE payment_method <> 'card'),
    'a gateway-confirmed card payment left an order recorded as cash');

  -- ONE ROW CARRIES THE MERCHANT ORDER NUMBER (20260919092000).
  --
  -- `orders_paycloud_merchant_order_no_unique` is GLOBAL. Writing the reference on every claimed
  -- order raised 23505 on the second one and rolled the whole settlement back -- a charged card
  -- with nothing recorded, on every multi-order tab. This assertion could not fail before the
  -- fixture schema gained that index, which is why the staging database found it first and this
  -- file did not.
  PERFORM public._expect('riviera/merchant_order_no_on_exactly_one_order',
    (SELECT count(*) FROM public.orders WHERE paycloud_merchant_order_no = 'MO-RIV-1') = 1,
    format('%s orders carry the merchant order number; the index permits one',
           (SELECT count(*) FROM public.orders WHERE paycloud_merchant_order_no = 'MO-RIV-1')));
  PERFORM public._expect('riviera/payment_reference_on_both_orders',
    (SELECT count(*) FROM public.orders WHERE payment_reference = 'MO-RIV-1') = 2,
    'payment_reference is the SHARED identifier and must reach every order in the settlement');

  -- F2. The ledger row is written by the SERVER, here, not by the device afterwards.
  SELECT count(*) INTO n_events FROM public.payment_events WHERE event_type = 'sale';
  PERFORM public._expect('riviera/ledger_row_written', n_events = 1,
    format('expected exactly 1 sale event, found %s', n_events));

  SELECT * INTO ev FROM public.payment_events WHERE event_type = 'sale';
  PERFORM public._expect('riviera/ledger_amount_is_gateway_amount', ev.amount = 720,
    format('ledger amount %s, gateway confirmed 720', ev.amount));
  PERFORM public._expect('riviera/ledger_names_both_orders', array_length(ev.order_ids, 1) = 2,
    'the ledger row must name every order the transaction paid for');
  PERFORM public._expect('riviera/ledger_has_transaction_id', ev.transaction_id = 'TXN-RIV-1',
    'the gateway transaction id is what reconciliation joins on');

  -- F15. The per-order figure must be NULL for a multi-order settlement: recording
  -- "gatewayAmount: 720" against the N$500 order is the defect being closed.
  SELECT * INTO aud FROM public.audit_logs WHERE action = 'payment.settlement_applied';
  PERFORM public._expect('riviera/audit_per_order_amount_is_null',
    aud.metadata->>'per_order_gateway_amount_cents' IS NULL,
    format('per-order gateway amount was %s on a 2-order settlement',
           aud.metadata->>'per_order_gateway_amount_cents'));
  PERFORM public._expect('riviera/audit_settlement_amount_is_aggregate',
    (aud.metadata->>'settlement_gateway_amount_cents')::integer = 72000, aud.metadata::text);
  -- Financial invariant 5, readable straight off the row.
  PERFORM public._expect('riviera/audit_intended_equals_applied',
    aud.metadata->'intended_order_ids' = aud.metadata->'applied_order_ids',
    format('intended %s applied %s',
           aud.metadata->'intended_order_ids', aud.metadata->'applied_order_ids'));

  PERFORM public._expect('riviera/tab_total_cleared',
    (SELECT total FROM public.tabs WHERE id = '22222222-2222-4222-8222-222222222222') = 0,
    'the tab still shows money owed after everything on it was paid');
END;
$$;

-- ==================================================================================================
-- T2. A SINGLE-ORDER SETTLEMENT still records a per-order gateway figure -- F15 must not
--     over-correct into recording nothing.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_single_order()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; aud record;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders
    (id, restaurant_id, tab_id, order_number, status, payment_status, payment_method, total,
     pending_charge_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000200', '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222', 200, 'pending', 'pending', NULL, 100, 10000);

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000200']::uuid[],
    10000, 10000, 'TXN-S1', 'MO-S1', 'card', 'MO-S1', NULL,
    'terminal_verify_payment', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('single/rpc_ok', (r->>'ok')::boolean, r::text);
  SELECT * INTO aud FROM public.audit_logs WHERE action = 'payment.settlement_applied';
  PERFORM public._expect('single/per_order_amount_recorded',
    (aud.metadata->>'per_order_gateway_amount_cents')::integer = 10000,
    'a one-order settlement IS that order''s gateway figure and must say so');
END;
$$;

-- ==================================================================================================
-- T3. A DUPLICATE WEBHOOK applies nothing the second time and writes no second ledger row.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_duplicate_webhook()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r1 jsonb; r2 jsonb; n integer; n_paid integer;
BEGIN
  PERFORM public._seed_riviera();
  INSERT INTO public.terminal_payment_intents
    (id, restaurant_id, tab_id, merchant_order_no, amount_cents, scope, order_ids, status)
  VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222', 'MO-DUP', 72000, 'orders',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
                'aaaaaaaa-0000-4000-8000-000000000155']::uuid[], 'launched');

  r1 := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-DUP', 'MO-DUP', 'card', 'MO-DUP',
    '33333333-3333-4333-8333-333333333333',
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  -- The identical delivery, again.
  r2 := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-DUP', 'MO-DUP', 'card', 'MO-DUP',
    '33333333-3333-4333-8333-333333333333',
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('duplicate/first_applied', (r1->>'applied')::boolean, r1::text);
  PERFORM public._expect('duplicate/second_is_ok', (r2->>'ok')::boolean, r2::text);
  PERFORM public._expect('duplicate/second_applied_nothing',
    (r2->>'applied')::boolean IS FALSE, r2::text);
  PERFORM public._expect('duplicate/second_reason_consumed',
    r2->>'reason' = 'already_consumed', r2->>'reason');

  SELECT count(*) INTO n FROM public.payment_events WHERE event_type = 'sale';
  PERFORM public._expect('duplicate/one_ledger_row_only', n = 1,
    format('financial invariant 6 broken: %s sale rows for one gateway transaction', n));

  SELECT count(*) INTO n_paid FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('duplicate/orders_still_two_paid', n_paid = 2, 'orders changed on replay');

  PERFORM public._expect('duplicate/intent_consumed',
    (SELECT consumed_at IS NOT NULL FROM public.terminal_payment_intents
      WHERE id = '33333333-3333-4333-8333-333333333333'), 'intent not marked consumed');
  PERFORM public._expect('duplicate/intent_records_applied_set',
    (SELECT settled_order_ids @> ARRAY['aaaaaaaa-0000-4000-8000-000000000154']::uuid[]
       FROM public.terminal_payment_intents WHERE id = '33333333-3333-4333-8333-333333333333'),
    'settled_order_ids must record what was actually written');
END;
$$;

-- ==================================================================================================
-- T4. GATEWAY / EXPECTED MISMATCH: nothing is written at all.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amount_mismatch()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_riviera();
  -- The gateway reports only the lead order's figure against a two-order settlement.
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 50000, 'TXN-MM', 'MO-MM', 'card', 'MO-MM', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('mismatch/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('mismatch/reason', r->>'reason' = 'amount_mismatch', r->>'reason');

  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('mismatch/no_order_written', n = 0,
    format('%s orders were marked paid on a refused settlement', n));
  SELECT count(*) INTO n FROM public.payment_events;
  PERFORM public._expect('mismatch/no_ledger_row', n = 0, 'a refused settlement wrote a ledger row');
END;
$$;

-- ==================================================================================================
-- T5. A GRATUITY: the expectation is the CHARGE, not the sum of order totals.
--     (Mutation M4 -- "use orders.total as the gateway amount" -- must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_tipped_charge()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n_tips integer;
BEGIN
  -- N$220 + N$500 of food, plus a N$30 gratuity = N$750 charged. sum(total) is N$720.
  PERFORM public._seed_riviera(3000);

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    75000, 75000, 'TXN-TIP', 'MO-TIP', 'card', 'MO-TIP', NULL,
    'terminal_verify_payment', 'term-1', 3000,
    '55555555-5555-4555-8555-555555555555', ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('tip/rpc_ok', (r->>'ok')::boolean, r::text);
  PERFORM public._expect('tip/expectation_is_the_charge',
    (r->>'expected_amount_cents')::integer = 75000,
    format('expected 75000 (food + tip), got %s -- summing order totals gives 72000',
           r->>'expected_amount_cents'));

  SELECT count(*) INTO n_tips FROM public.payment_tips;
  PERFORM public._expect('tip/recorded_separately', n_tips = 1,
    'the gratuity must land in payment_tips, never inside an order total');
  PERFORM public._expect('tip/order_totals_untouched',
    (SELECT sum(total) FROM public.orders) = 720,
    'a tip entered an order total');
END;
$$;

-- ==================================================================================================
-- T6. TOCTOU: the tab changed after the intent was minted. (Mutation M5 must break this.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_stale_intent()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_riviera();
  -- A waiter amends order #154 between preparation and settlement: N$220 -> N$260.
  UPDATE public.orders
     SET total = 260, pending_charge_cents = 26000
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000154';

  /**
   * THE CASE ONLY THE TOCTOU CHECK CAN SEE, and it has to be constructed deliberately.
   *
   * The obvious version of this test -- charge the preparation-time N$720 against a tab that now
   * totals N$760 -- is ALSO caught by the gateway-amount comparison, so it proves nothing about
   * the staleness guard specifically. (The mutation harness established that: removing the
   * staleness check left that version green, because `amount_mismatch` refused it anyway.)
   *
   * So here the DEVICE also recomputed and charged the NEW figure, N$760. The gateway echo agrees
   * with the tab as it now stands, and the amount check passes. The only thing wrong is that this
   * is no longer the settlement the intent described: N$720 was what the customer agreed to pay.
   * Without the staleness check this settles silently against financial state that moved
   * underneath it.
   */
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000,   -- what preparation recorded
    76000,   -- what the gateway confirmed, matching the tab as it stands NOW
    'TXN-STALE', 'MO-STALE', 'card', 'MO-STALE', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('stale/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('stale/reason',
    r->>'reason' = 'target_changed_since_preparation', r->>'reason');
  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('stale/nothing_applied', n = 0,
    'a stale payment intent settled against changed financial state');
END;
$$;

-- ==================================================================================================
-- T7. AN ILLEGAL TRANSITION refuses the WHOLE settlement, not just that order.
--     (Mutation M7 must break this.) This is also the F5 atomicity proof: one bad order in the set
--     leaves the OTHER order unwritten too.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_illegal_transition_is_atomic()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_riviera();
  -- #154 was cancelled for a reason the E04111 rule does NOT clear, so it may not become paid.
  UPDATE public.orders
     SET payment_status = 'cancelled', status = 'cancelled',
         cancelled_at = now(), cancellation_reason = 'staff_cancelled'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000154';

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-ILL', 'MO-ILL', 'card', 'MO-ILL', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL,
    ARRAY[]::uuid[],  -- nothing is cleared for recovery
    '2.37');

  PERFORM public._expect('illegal/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('illegal/reason', r->>'reason' = 'illegal_transition', r->>'reason');

  -- ATOMICITY. #155 is perfectly settleable and must NOT be left paid on its own: that is the
  -- "order #1 paid, order #2 unpaid" partial state F5 forbids.
  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('illegal/no_partial_application', n = 0,
    format('%s order(s) were left paid by a settlement that refused', n));
  SELECT count(*) INTO n FROM public.payment_events;
  PERFORM public._expect('illegal/no_ledger_row', n = 0, 'a refused settlement wrote a ledger row');

  -- ================================================================================================
  -- THE OTHER ORDERING, AND IT IS THE WHOLE POINT.
  --
  -- Above, the CANCELLED order is #154 and it sorts FIRST, so the claim loop met it before it had
  -- written anything and the assertions passed whether or not the function was atomic. That is a
  -- test passing on the arrangement of its fixture.
  --
  -- Here the LEGAL order sorts first. Before 20260919093000 the loop paid it, then refused at #155,
  -- and RETURN left the payment in place -- reason=illegal_transition, claimed=[], one order paid,
  -- no ledger row. Measured on staging, not reasoned about.
  -- ================================================================================================
  PERFORM public._seed_riviera();
  UPDATE public.orders
     SET payment_status = 'cancelled', status = 'cancelled',
         cancelled_at = now(), cancellation_reason = 'staff_cancelled'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000155';

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-ILL2', 'MO-ILL2', 'card', 'MO-ILL2', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('illegal_reversed/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('illegal_reversed/reason', r->>'reason' = 'illegal_transition', r->>'reason');

  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('illegal_reversed/no_partial_application', n = 0,
    format('%s order(s) left paid by a refusal reached AFTER the loop had already written', n));
  SELECT count(*) INTO n FROM public.payment_events;
  PERFORM public._expect('illegal_reversed/no_ledger_row', n = 0,
    'a refused settlement wrote a ledger row');
  SELECT count(*) INTO n FROM public.audit_logs WHERE action = 'payment.settlement_applied';
  PERFORM public._expect('illegal_reversed/no_audit_row', n = 0,
    'an order was paid with no settlement audit row to find it by');
END;
$$;

-- ==================================================================================================
-- T8. THE E04111 RECOVERY still works: a cancelled order the caller HAS cleared may become paid.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_e04111_recovery()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public._seed_riviera();
  UPDATE public.orders
     SET payment_status = 'cancelled', status = 'cancelled',
         cancelled_at = now(), cancellation_reason = 'auto_cancel_e04111_persistent'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000154';

  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, 72000, 'TXN-REC', 'MO-REC', 'card', 'MO-REC', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL,
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154']::uuid[],
    '2.37');

  PERFORM public._expect('recovery/ok', (r->>'ok')::boolean, r::text);
  PERFORM public._expect('recovery/cancelled_order_recovered',
    (SELECT payment_status = 'paid' AND cancelled_at IS NULL AND cancellation_reason IS NULL
       FROM public.orders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000154'),
    'a recovered order must not stay half-cancelled');
  PERFORM public._expect('recovery/recorded_in_audit',
    (SELECT metadata->'recovered_from_cancelled' <> '[]'::jsonb
       FROM public.audit_logs WHERE action = 'payment.settlement_applied'),
    'the recovery must be visible in the settlement audit row');
END;
$$;

-- ==================================================================================================
-- T9. THE INTENT DEFINES THE TARGET SET. Settling a different set than the intent named refuses.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_intent_target_set_is_binding()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_riviera();
  INSERT INTO public.terminal_payment_intents
    (id, restaurant_id, tab_id, merchant_order_no, amount_cents, scope, order_ids, status)
  VALUES ('33333333-3333-4333-8333-333333333334', '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222', 'MO-BIND', 72000, 'orders',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
                'aaaaaaaa-0000-4000-8000-000000000155']::uuid[], 'launched');

  -- The caller tries to settle only the lead order -- EXACTLY the Riviera shape, now refused.
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    50000, 72000, 'TXN-BIND', 'MO-BIND', 'card', 'MO-BIND',
    '33333333-3333-4333-8333-333333333334',
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('binding/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('binding/reason',
    r->>'reason' = 'target_set_differs_from_intent', r->>'reason');
  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('binding/nothing_applied', n = 0,
    'a settlement narrower than its intent was applied');
END;
$$;

-- ==================================================================================================
-- T10. AN ABSENT GATEWAY AMOUNT IS NOT AGREEMENT.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_absent_gateway_amount()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n integer;
BEGIN
  PERFORM public._seed_riviera();
  r := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-0000-4000-8000-000000000154',
          'aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
    72000, NULL, 'TXN-NONE', 'MO-NONE', 'card', 'MO-NONE', NULL,
    'paycloud_webhook_valid_signature', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.37');

  PERFORM public._expect('absent/refused', (r->>'ok')::boolean IS FALSE, r::text);
  PERFORM public._expect('absent/reason', r->>'reason' = 'gateway_amount_absent', r->>'reason');
  SELECT count(*) INTO n FROM public.orders WHERE payment_status = 'paid';
  PERFORM public._expect('absent/nothing_applied', n = 0, 'settled on an unverified amount');
END;
$$;

-- ==================================================================================================
-- T11. DATABASE CONSTRAINTS. (Mutation M6 -- dropping them -- must break these.)
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_db_constraints()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_alloc uuid;
  v_line  uuid;
  ok boolean;
BEGIN
  PERFORM public._seed();
  INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000300', '11111111-1111-4111-8111-111111111111',
          300, 'pending', 50);
  INSERT INTO public.order_lines (order_id, source_item_index)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000300', 0) RETURNING id INTO v_line;
  INSERT INTO public.order_line_allocations
    (restaurant_id, order_id, order_line_id, allocated_to, quantity_allocated, amount_cents,
     created_by_actor_kind)
  VALUES ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000300',
          v_line, 'guest-1', 1, 5000, 'terminal') RETURNING id INTO v_alloc;

  -- F13. One allocation, settled twice.
  INSERT INTO public.order_line_allocation_settlements
    (restaurant_id, order_line_allocation_id, amount_cents, method)
  VALUES ('11111111-1111-4111-8111-111111111111', v_alloc, 5000, 'card');

  ok := false;
  BEGIN
    INSERT INTO public.order_line_allocation_settlements
      (restaurant_id, order_line_allocation_id, amount_cents, method)
    VALUES ('11111111-1111-4111-8111-111111111111', v_alloc, 5000, 'card');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  PERFORM public._expect('constraint/allocation_settled_twice_refused', ok,
    'the database accepted a second settlement for one allocation');

  -- F14. One gateway transaction, recorded twice for one venue.
  INSERT INTO public.payment_events
    (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
     transaction_id, amount, idempotency_key, reason_code)
  VALUES ('11111111-1111-4111-8111-111111111111',
          ARRAY['aaaaaaaa-0000-4000-8000-000000000300']::uuid[], 'sale', 'BO-1', 'BO-1',
          'TXN-UNIQUE', 50, 'BO-1', 'sale');

  ok := false;
  BEGIN
    INSERT INTO public.payment_events
      (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
       transaction_id, amount, idempotency_key, reason_code)
    VALUES ('11111111-1111-4111-8111-111111111111',
            ARRAY['aaaaaaaa-0000-4000-8000-000000000300']::uuid[], 'sale', 'BO-2', 'BO-2',
            'TXN-UNIQUE', 50, 'BO-2', 'sale');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  PERFORM public._expect('constraint/duplicate_transaction_id_refused', ok,
    'the database accepted two payment records for one gateway transaction');

  -- ...but a DIFFERENT venue holding the same id is fine, which is why the index is scoped.
  ok := true;
  BEGIN
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000301', '99999999-9999-4999-8999-999999999999',
            301, 'pending', 50);
    INSERT INTO public.payment_events
      (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
       transaction_id, amount, idempotency_key, reason_code)
    VALUES ('99999999-9999-4999-8999-999999999999',
            ARRAY['aaaaaaaa-0000-4000-8000-000000000301']::uuid[], 'sale', 'BO-1', 'BO-1',
            'TXN-UNIQUE', 50, 'BO-1', 'sale');
  EXCEPTION WHEN unique_violation THEN ok := false;
  END;
  PERFORM public._expect('constraint/cross_venue_transaction_id_allowed', ok,
    'a global unique index would refuse a real payment at another venue');

  -- F12. Two venues, one idempotency key.
  ok := true;
  BEGIN
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total,
                               idempotency_key)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000302', '11111111-1111-4111-8111-111111111111',
            302, 'pending', 50, 'shared-key');
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total,
                               idempotency_key)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000303', '99999999-9999-4999-8999-999999999999',
            303, 'pending', 50, 'shared-key');
  EXCEPTION WHEN unique_violation THEN ok := false;
  END;
  PERFORM public._expect('constraint/idempotency_key_is_per_venue', ok,
    'a global idempotency index refused a second venue''s order');

  -- ...and the SAME venue reusing it is still refused.
  ok := false;
  BEGIN
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total,
                               idempotency_key)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000304', '11111111-1111-4111-8111-111111111111',
            304, 'pending', 50, 'shared-key');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  PERFORM public._expect('constraint/idempotency_key_still_unique_in_venue', ok,
    'idempotency stopped working inside a venue');

  -- The state-machine alphabet.
  ok := false;
  BEGIN
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000305', '11111111-1111-4111-8111-111111111111',
            305, 'refunded_maybe', 50);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  PERFORM public._expect('constraint/payment_status_enumerated', ok,
    'the database accepted a payment_status outside the declared nine');

  -- ...and every one of the nine IS accepted, so the constraint cannot be too tight.
  ok := true;
  BEGIN
    INSERT INTO public.orders (id, restaurant_id, order_number, payment_status, total)
    SELECT gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 400 + i, s, 50
      FROM unnest(ARRAY['unpaid','pending','terminal_pending','cash_pending','failed',
                        'amount_mismatch_hold','verification_unavailable_hold','paid','cancelled'])
           WITH ORDINALITY AS t(s, i);
  EXCEPTION WHEN check_violation THEN ok := false;
  END;
  PERFORM public._expect('constraint/all_nine_statuses_accepted', ok,
    'the CHECK constraint refuses a value the application legitimately writes');
END;
$$;

-- ==================================================================================================
-- T12. SECURITY. Neither anon nor authenticated may execute the settlement function.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_security_grants()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE sig text := 'public.settle_order_payment(uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)';
BEGIN
  PERFORM public._expect('security/anon_cannot_execute',
    NOT has_function_privilege('anon', sig, 'EXECUTE'),
    'anon can execute the settlement RPC');
  PERFORM public._expect('security/authenticated_cannot_execute',
    NOT has_function_privilege('authenticated', sig, 'EXECUTE'),
    'an ordinary signed-in user can execute the settlement RPC');
  PERFORM public._expect('security/service_role_can_execute',
    has_function_privilege('service_role', sig, 'EXECUTE'),
    'the server routes cannot execute the settlement RPC');
  PERFORM public._expect('security/public_cannot_execute',
    NOT has_function_privilege('public', sig, 'EXECUTE'),
    'PUBLIC can execute the settlement RPC');
  -- The same assertion for the function this one is modelled on, so a regression there is caught
  -- by this suite too.
  PERFORM public._expect('security/allocations_rpc_still_locked_down',
    NOT has_function_privilege('anon',
      'public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid)', 'EXECUTE'),
    'anon can execute the allocation settlement RPC');
END;
$$;

-- ==================================================================================================
-- RUN THEM ALL. Each in its own subtransaction so one failure cannot hide the others.
-- ==================================================================================================
DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_riviera_multi_order',
    '_t_single_order',
    '_t_duplicate_webhook',
    '_t_amount_mismatch',
    '_t_tipped_charge',
    '_t_stale_intent',
    '_t_illegal_transition_is_atomic',
    '_t_e04111_recovery',
    '_t_intent_target_set_is_binding',
    '_t_absent_gateway_amount',
    '_t_db_constraints',
    '_t_security_grants'
  ];
BEGIN
  FOREACH t IN ARRAY tests LOOP
    BEGIN
      EXECUTE format('SELECT public.%I()', t);
    EXCEPTION WHEN OTHERS THEN
      -- A test that THREW is a failed test, not a crashed suite. Recorded under its own name so
      -- the count stays honest and the reason survives.
      INSERT INTO public._test_results (name, passed, detail)
      VALUES (t || '/threw', false, SQLERRM)
      ON CONFLICT (name) DO UPDATE SET passed = false, detail = EXCLUDED.detail;
      RAISE WARNING 'THREW % -- %', t, SQLERRM;
    END;
  END LOOP;
END;
$$;
