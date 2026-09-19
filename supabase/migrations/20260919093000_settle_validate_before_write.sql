-- @env: both
--
-- FIX TO 20260919090000: a refused settlement must write nothing, and one could.
--
-- Found by the staging smoke, in the scenario that settles one legal order together with one
-- cancelled one. The function returned `illegal_transition` with `claimed_order_ids: []` -- and
-- the legal order was PAID, with no payment_events row and no audit row naming it.
--
-- The cause is one sentence: plpgsql's RETURN ends the function, not the transaction. The claim
-- loop wrote its UPDATE for each order in turn and refused when it reached the cancelled one, under
-- a comment asserting that returning rolled back every write above it. It never did. Whether a
-- customer's order came out paid depended on whether its uuid sorted before the cancelled order's,
-- because the target set is locked `ORDER BY id`.
--
-- The suite did not catch it: `_t_illegal_transition_is_atomic` asserts exactly this and PASSED,
-- because its two fixture ids happen to sort the safe way round. Both orderings are now asserted.
--
-- The fix is to check every transition BEFORE the first write rather than during it. Nothing else
-- changes; the body below is 20260919092000's with one loop added and two comments corrected.

CREATE OR REPLACE FUNCTION public.settle_order_payment(
  p_restaurant_id uuid,
  -- THE TARGET SET. Every one of these is paid, or none is.
  p_order_ids uuid[],
  -- What the caller computed from the same rows. Re-derived here under lock and required to agree;
  -- a disagreement means the tab changed between preparation and settlement (TOCTOU).
  p_expected_amount_cents integer,
  -- The gateway's own figure. THE authoritative collected amount.
  p_gateway_amount_cents integer,
  p_gateway_transaction_id text,
  p_payment_reference text,
  -- The channel the money came through, established by the gateway confirmation. NOT the order's
  -- previous payment_method (F3).
  p_payment_method text,
  p_merchant_order_no text,
  p_intent_id uuid,
  p_source text,
  p_terminal_id text,
  p_tip_cents integer,
  p_tip_staff_user_id uuid,
  -- Order ids the caller's E04111 rule has cleared for cancelled -> paid recovery. Anything else
  -- that is cancelled refuses.
  p_allow_cancelled_recovery uuid[],
  p_app_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent          record;
  v_row             jsonb;
  /**
   * THE TARGET SET, MATERIALISED ONCE.
   *
   * One jsonb array, built by one locking SELECT. The expectation is summed over it and the write
   * loop iterates it, so there is no second collection in scope and the Riviera substitution --
   * verify `settlementRows`, write `orderRows` -- is not expressible. A jsonb array rather than a
   * temp table because this runs through a transaction-mode pooler, where a session-scoped temp
   * table is not reliably the caller's own.
   */
  v_target          jsonb := '[]'::jsonb;
  v_paid_at         timestamptz := now();
  v_found           integer := 0;
  v_recomputed      integer := 0;
  v_claimed         uuid[] := ARRAY[]::uuid[];
  v_recovered       uuid[] := ARRAY[]::uuid[];
  v_status          text;
  v_order_id        uuid;
  v_tab_id          uuid;
  /** The tab this settlement belongs to, locked before any order is. */
  v_settle_tab_id   uuid;
  /** True when that tab had already been closed out. Recorded, never used to refuse. */
  v_tab_was_closed  boolean := false;
  v_tab_ids         uuid[] := ARRAY[]::uuid[];
  v_tip_tab_id      uuid;
  v_method          text;
  v_tip             integer := COALESCE(p_tip_cents, 0);
  v_ledger_rows     integer := 0;
  v_new_total       numeric;
  v_ref             text;
  v_txn             text;
  v_allow           uuid[] := COALESCE(p_allow_cancelled_recovery, ARRAY[]::uuid[]);
  /**
   * True when no order ANYWHERE already holds this merchant order number. See the
   * `paycloud_merchant_order_no` write below for why a settlement asks.
   */
  v_ref_free        boolean := false;
BEGIN
  -- ---- 0. arguments ------------------------------------------------------------------------
  IF p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'settle_order_payment: at least one order id is required';
  END IF;

  -- THE METHOD IS ESTABLISHED BY THE GATEWAY, NOT CARRIED OVER (F3). `(row.payment_method) ||
  -- 'card'` in the webhook left a card payment recorded as cash whenever the order had previously
  -- been moved to cash_pending. There is no fallback to the row's own value anywhere below.
  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('card', 'cash', 'paytoday') THEN
    RAISE EXCEPTION 'settle_order_payment: unsupported payment method %', p_payment_method;
  END IF;

  v_txn := NULLIF(btrim(COALESCE(p_gateway_transaction_id, '')), '');
  v_ref := COALESCE(NULLIF(btrim(COALESCE(p_merchant_order_no, '')), ''), p_payment_reference);
  IF v_ref IS NULL OR btrim(v_ref) = '' THEN
    RAISE EXCEPTION 'settle_order_payment: a payment reference is required';
  END IF;

  IF p_gateway_amount_cents IS NULL THEN
    -- ABSENT IS NOT AGREEING. Carried over from GATEWAY_AMOUNT_TOLERANCE_CENTS's own rule: a
    -- missing amount is an unverified payment, and an unverified payment is not applied.
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'gateway_amount_absent', 'claimed_order_ids', '[]'::jsonb);
  END IF;

  -- ---- 1./2. the intent, locked; refuse a second application -------------------------------
  IF p_intent_id IS NOT NULL THEN
    -- tab_id is SELECTED because the tab lock below reads it. An unselected column reads as
    -- "no field" in plpgsql, not as NULL, so omitting it is an error and not a silent NULL.
    SELECT id, restaurant_id, status, consumed_at, amount_cents, scope, order_ids, settled_order_ids,
           tab_id
      INTO v_intent
      FROM public.terminal_payment_intents
     WHERE id = p_intent_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settle_order_payment: intent % not found', p_intent_id;
    END IF;
    IF v_intent.restaurant_id <> p_restaurant_id THEN
      RAISE EXCEPTION 'settle_order_payment: intent % belongs to another restaurant', p_intent_id;
    END IF;

    -- IDEMPOTENT, NOT AN ERROR. A duplicate webhook, or a device callback racing the webhook,
    -- reaches here second and must be told what the first one did -- not made to fail, and
    -- certainly not allowed to write again.
    IF v_intent.consumed_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'reason', 'already_consumed',
        'applied', false,
        'intent_id', p_intent_id,
        'claimed_order_ids', to_jsonb(COALESCE(v_intent.settled_order_ids, ARRAY[]::uuid[])));
    END IF;

    IF v_intent.status = 'failed' THEN
      -- The device said the charge failed and the gateway says it succeeded. Not resolved either
      -- way here: settling contradicts the device, releasing contradicts the gateway, and a human
      -- must see it. Same ruling the allocation path already applies.
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'intent_reported_failed', 'intent_id', p_intent_id,
        'claimed_order_ids', '[]'::jsonb);
    END IF;

    -- FINANCIAL INVARIANT 4: payment intent amount = gateway amount.
    IF v_intent.amount_cents <> p_gateway_amount_cents THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'intent_amount_mismatch',
        'intent_amount_cents', v_intent.amount_cents,
        'gateway_amount_cents', p_gateway_amount_cents,
        'claimed_order_ids', '[]'::jsonb);
    END IF;

    -- FINANCIAL INVARIANT 5: intended target set = applied target set.
    --
    -- Asked as a SET comparison in both directions, not a length check: the Riviera write loop ran
    -- over a strict SUBSET of the verified set, and a subset has a smaller length -- but so does a
    -- completely different set of the same size, which a length check would wave through.
    IF v_intent.scope = 'orders' AND NOT (
         v_intent.order_ids @> p_order_ids AND p_order_ids @> v_intent.order_ids) THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'target_set_differs_from_intent',
        'intent_order_ids', to_jsonb(v_intent.order_ids),
        'requested_order_ids', to_jsonb(p_order_ids),
        'claimed_order_ids', '[]'::jsonb);
    END IF;
  END IF;

  -- ---- 2b. THE TAB, LOCKED BEFORE THE ORDERS -----------------------------------------------
  --
  -- ==========================================================================================
  -- THE PAYMENT / TAB-CLOSE RACE
  -- ==========================================================================================
  --
  -- `close_table_session(p_table_id, p_restaurant_id)` settles every active tab on a table with a
  -- bare `UPDATE tabs SET status='settled', settled_at=now()`. It never touches `orders` and it
  -- takes no lock this function was taking, so the two lock sets were DISJOINT: a waiter closing
  -- the table and a card settlement landing could interleave freely, and whichever committed last
  -- decided the state with nothing recording that the other had happened.
  --
  -- Locking the tab row here makes the two serialise. `close_table_session`'s UPDATE blocks on
  -- this lock until the settlement commits, and vice versa.
  --
  -- ==========================================================================================
  -- A CLOSED TAB DOES NOT REFUSE THE SETTLEMENT, AND THAT IS DELIBERATE
  -- ==========================================================================================
  --
  -- By the time this runs the card HAS been charged. Refusing would leave a real charge with no
  -- settlement recorded against it -- the orphan this whole area exists to prevent -- and would be
  -- a payment SILENTLY LOST, which the brief names as the outcome to avoid. So the settlement
  -- still applies, and `tab_was_closed` is carried into the audit row and the return value so it
  -- is never silent. A walkout-closed tab that turns out to have been paid is exactly the case
  -- reconciliation needs to see.
  --
  -- Cancelled ORDERS are a different question and are already refused below: `cancelled -> paid`
  -- needs the caller's E04111 allow-list, so a written-off order cannot be revived by this path.
  --
  -- LOCK ORDER IS TAB, THEN ORDERS, ALWAYS. `close_table_session` takes tabs -> customer_sessions
  -- -> restaurant_tables and never touches orders, so there is no cycle. Taking the tab lock after
  -- the orders would create one the moment any other writer took them in the documented order.
  -- NESTED, not `AND`-ed: plpgsql does not guarantee short-circuit evaluation, so a single
  -- condition touching v_intent.tab_id raises "record is not assigned yet" on every no-intent call.
  IF p_intent_id IS NOT NULL THEN
    v_settle_tab_id := v_intent.tab_id;
  END IF;

  IF v_settle_tab_id IS NULL THEN
    -- No intent, so the tab is whichever one these orders sit on. A plain read is correct here:
    -- it only decides WHICH row to lock, and an order does not move between tabs.
    SELECT o.tab_id INTO v_settle_tab_id
      FROM public.orders o
     WHERE o.id = ANY (p_order_ids)
       AND o.restaurant_id = p_restaurant_id
       AND o.tab_id IS NOT NULL
     LIMIT 1;
  END IF;

  IF v_settle_tab_id IS NOT NULL THEN
    SELECT (t.status = 'settled' OR t.settled_at IS NOT NULL)
      INTO v_tab_was_closed
      FROM public.tabs t
     WHERE t.id = v_settle_tab_id
     FOR UPDATE;
    -- A tab that cannot be found is not a reason to refuse money; NULL stays NULL and the
    -- settlement proceeds exactly as it would for a tab-less POS order.
    v_tab_was_closed := COALESCE(v_tab_was_closed, false);
  END IF;

  -- ---- 3. THE TARGET SET, LOCKED AND MATERIALISED ------------------------------------------
  --
  -- ORDER BY id inside the locking subquery so two concurrent settlements over overlapping orders
  -- take their row locks in the same sequence and deadlock is not reachable.
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb), count(*)::integer
    INTO v_target, v_found
    FROM (
      SELECT o.id,
             o.tab_id,
             o.payment_status,
             -- The recorded attempt, falling back to the order total. The same rule
             -- lib/payments/expected-charge.ts applies, which is what the caller summed.
             COALESCE(NULLIF(o.pending_charge_cents, 0), round(o.total * 100)::integer)
               AS charge_cents
        FROM public.orders o
       WHERE o.id = ANY (p_order_ids)
         AND o.restaurant_id = p_restaurant_id
       ORDER BY o.id
         FOR UPDATE
    ) t;

  -- EVERY NAMED ORDER MUST BE PRESENT. A partial read is the Riviera outcome arrived at by
  -- accident, so it is a refusal rather than a smaller settlement.
  IF v_found <> array_length(p_order_ids, 1) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'orders_missing',
      'requested', array_length(p_order_ids, 1), 'found', v_found,
      'claimed_order_ids', '[]'::jsonb);
  END IF;

  -- ---- 5. the expectation, summed over THAT SAME SET ---------------------------------------
  SELECT COALESCE(sum((e->>'charge_cents')::integer), 0)::integer
    INTO v_recomputed
    FROM jsonb_array_elements(v_target) e;

  -- TOCTOU. The caller summed these same orders BEFORE the reader was launched. If the figure has
  -- moved since, the tab was amended mid-payment and the intent no longer describes what is being
  -- paid for -- refuse rather than settle a stale snapshot.
  IF p_expected_amount_cents IS NOT NULL AND v_recomputed <> p_expected_amount_cents THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'target_changed_since_preparation',
      'expected_at_preparation_cents', p_expected_amount_cents,
      'expected_now_cents', v_recomputed,
      'claimed_order_ids', '[]'::jsonb);
  END IF;

  -- ---- 6. GATEWAY AMOUNT = INTERNAL PAYMENT AMOUNT (financial invariant 1) ------------------
  --
  -- Exact. GATEWAY_AMOUNT_TOLERANCE_CENTS is zero because Finatic echoes back our own figure, so a
  -- cent of daylight means the reference correlated to a DIFFERENT sale.
  IF v_recomputed <> p_gateway_amount_cents THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'amount_mismatch',
      'expected_cents', v_recomputed,
      'gateway_amount_cents', p_gateway_amount_cents,
      'claimed_order_ids', '[]'::jsonb);
  END IF;

  -- ---- 7./8. APPLY TO ALL INTENDED ORDERS --------------------------------------------------
  --
  -- Iterating v_target: the same relation the expectation was summed over, three statements above.
  -- ---- 6b. EVERY TRANSITION IS CHECKED BEFORE THE FIRST WRITE ------------------------------
  --
  -- RETURN DOES NOT ROLL ANYTHING BACK. The claim loop below used to carry these checks inline and
  -- `RETURN` when one failed, under a comment claiming that returning rolled back every write
  -- above. In plpgsql it does not: RETURN ends the FUNCTION, not the transaction, and a caller
  -- that invoked this through a plain statement commits whatever was written before it.
  --
  -- MEASURED ON STAGING 2026-09-19, one legal order and one cancelled order in a single
  -- settlement, run twice with the ids chosen so the sort order differed:
  --
  --     legal order's id sorts FIRST  ->  reason=illegal_transition, claimed=[], order PAID
  --     legal order's id sorts LAST   ->  reason=illegal_transition, claimed=[], nothing written
  --
  -- So the caller was told the settlement was refused while an order had been marked paid, with no
  -- ledger row and no audit row to find it by -- a partial application, which is the exact outcome
  -- this function exists to make unreachable, arrived at through the code meant to prevent it. It
  -- was invisible to the test suite because the fixture's two ids happened to sort the safe way.
  --
  -- The loop's own guards are LEFT IN PLACE below. They are unreachable now and cost nothing, and
  -- a guard that is checked twice is cheaper than one that moves.
  -- Written "AS e" where the claim loop writes a bare "e", so a mutation anchored on the claim
  -- loop's header cannot land here instead -- the two would otherwise be the same string.
  FOR v_row IN SELECT e FROM jsonb_array_elements(v_target) AS e LOOP
    v_order_id := (v_row->>'id')::uuid;
    v_status   := v_row->>'payment_status';

    CONTINUE WHEN v_status = 'paid';

    IF v_status = 'cancelled' AND NOT (v_order_id = ANY (v_allow)) THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'illegal_transition',
        'order_id', v_order_id, 'from', v_status, 'to', 'paid',
        'claimed_order_ids', '[]'::jsonb);
    END IF;

    IF v_status NOT IN (
         'unpaid', 'pending', 'terminal_pending', 'cash_pending', 'failed',
         'amount_mismatch_hold', 'verification_unavailable_hold', 'cancelled') THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'illegal_transition',
        'order_id', v_order_id, 'from', v_status, 'to', 'paid',
        'claimed_order_ids', '[]'::jsonb);
    END IF;
  END LOOP;

  -- ONE ROW PER PAYMENT CARRIES THE MERCHANT ORDER NUMBER. `orders_paycloud_merchant_order_no_unique`
  -- is a GLOBAL partial unique index, and its own migration (20260502120000) states the rule it
  -- encodes: "table receipts share payment_reference; only the lead row holds
  -- paycloud_merchant_order_no". Asked here rather than inside the loop so the answer cannot
  -- change between two orders of one settlement.
  SELECT NOT EXISTS (
    SELECT 1 FROM public.orders WHERE paycloud_merchant_order_no = v_ref)
    INTO v_ref_free;

  FOR v_row IN SELECT e FROM jsonb_array_elements(v_target) e LOOP
    v_order_id := (v_row->>'id')::uuid;
    v_status   := v_row->>'payment_status';
    v_tab_id   := NULLIF(v_row->>'tab_id', '')::uuid;

    IF v_status = 'paid' THEN
      -- Already paid by whoever won the race. Not an error and not a re-write; reported so the
      -- caller can tell a duplicate from a conflict.
      CONTINUE;
    END IF;

    -- UNREACHABLE, KEPT DELIBERATELY. 6b has already refused every settlement that would reach
    -- either branch below, before anything was written. These stay as a second reading of the same
    -- rule, so moving 6b cannot silently remove the check.
    IF v_status = 'cancelled' AND NOT (v_order_id = ANY (v_allow)) THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'illegal_transition',
        'order_id', v_order_id, 'from', v_status, 'to', 'paid',
        'claimed_order_ids', '[]'::jsonb);
    END IF;

    IF v_status NOT IN (
         'unpaid', 'pending', 'terminal_pending', 'cash_pending', 'failed',
         'amount_mismatch_hold', 'verification_unavailable_hold', 'cancelled') THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'illegal_transition',
        'order_id', v_order_id, 'from', v_status, 'to', 'paid',
        'claimed_order_ids', '[]'::jsonb);
    END IF;

    IF v_status = 'cancelled' THEN
      v_recovered := v_recovered || v_order_id;
    END IF;

    UPDATE public.orders
       SET payment_status      = 'paid',
           status              = 'completed',
           -- 8. THE GATEWAY'S CHANNEL, unconditionally. No COALESCE onto the row's own method.
           payment_method      = v_method,
           payment_reference   = p_payment_reference,
           payment_voucher_no  = COALESCE(v_txn, p_payment_reference),
           paid_at             = v_paid_at,
           completed_at        = v_paid_at,
           cancelled_at        = NULL,
           cancellation_reason = NULL,
           terminal_pushed_at  = NULL,
           -- F18: pending_* describes an ATTEMPT, and this one has landed. Clearing it here ties
           -- expiry to the payment state rather than to a sweeper's clock.
           pending_charge_cents      = NULL,
           pending_tip_cents         = 0,
           pending_tip_staff_user_id = NULL,
           pending_settlement_id     = NULL,
           paycloud_transaction_id   = COALESCE(v_txn, paycloud_transaction_id),
           -- LEAD ROW ONLY, and never rotated.
           --
           -- Writing it on every claimed order raised 23505 on
           -- `orders_paycloud_merchant_order_no_unique` the moment a settlement covered more than
           -- one order whose reference was still NULL -- which is every multi-order tab, including
           -- the N$220 + N$500 case this whole area exists for. The exception rolled the entire
           -- settlement back, so a charged card would have been left with nothing recorded.
           --
           -- Nothing is lost by narrowing it: `payment_reference` is written on EVERY claimed
           -- order two lines above and is the identifier the shared readers use
           -- (lib/guest-orders/validation.ts matches either column), the ledger row carries the
           -- full `order_ids`, and the intent records `settled_order_ids`.
           paycloud_merchant_order_no = CASE
             WHEN v_ref_free AND v_order_id = p_order_ids[1]
               THEN COALESCE(paycloud_merchant_order_no, v_ref)
             ELSE paycloud_merchant_order_no
           END
     WHERE id = v_order_id
       AND restaurant_id = p_restaurant_id;

    v_claimed := v_claimed || v_order_id;
    IF v_tab_id IS NOT NULL AND NOT (v_tab_id = ANY (v_tab_ids)) THEN
      v_tab_ids := v_tab_ids || v_tab_id;
    END IF;
  END LOOP;

  -- ---- 9. THE IMMUTABLE LEDGER ROW (F2) ----------------------------------------------------
  --
  -- Written HERE, by the server, at the moment gateway confirmation is established -- not by a
  -- fire-and-forget call from the device afterwards. Measured 2026-09-19: 1,630 paid card orders
  -- worth N$110,027 have no payment_events sale row, because the device's recordSaleEvent is the
  -- only writer and it catches its own failures.
  --
  -- ONE LEDGER, NOT TWO. Same table and same idempotency key (business_order_no) the device already
  -- writes, so the device's later call finds this row through its existing 23505 branch, compares
  -- order_ids and amount, and returns it. Two competing ledgers is what F2 forbids.
  --
  -- ON CONFLICT DO NOTHING: whoever arrives first writes it, so one gateway transaction can never
  -- produce two sale rows (financial invariant 6).
  IF array_length(v_claimed, 1) IS NOT NULL THEN
    INSERT INTO public.payment_events (
      restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
      transaction_id, terminal_id, app_version, amount, currency, idempotency_key, reason_code,
      raw_gateway_response)
    VALUES (
      p_restaurant_id,
      -- THE WHOLE TARGET SET, not the claimed subset: the ledger records what the gateway was asked
      -- for and paid, and an order already paid by a racing caller was still covered by it.
      p_order_ids,
      'sale',
      v_ref,
      v_ref,
      v_txn,
      p_terminal_id,
      p_app_version,
      p_gateway_amount_cents::numeric / 100,
      'NAD',
      v_ref,
      'sale',
      jsonb_build_object(
        'recorded_by', 'server',
        'source', p_source,
        'settlement_basis', CASE WHEN p_intent_id IS NULL THEN 'settlement_id' ELSE 'intent' END,
        'intent_id', p_intent_id,
        'gateway_transaction_id', v_txn))
    ON CONFLICT (restaurant_id, idempotency_key) DO NOTHING;

    GET DIAGNOSTICS v_ledger_rows = ROW_COUNT;
  END IF;

  -- ---- the gratuity ------------------------------------------------------------------------
  --
  -- Split back out of the single charged figure, exactly as the allocation path does. A tip is not
  -- revenue and never enters an order total (owner's ruling 2026-09-05).
  IF v_tip > 0 AND p_tip_staff_user_id IS NOT NULL AND array_length(v_claimed, 1) IS NOT NULL THEN
    SELECT NULLIF(e->>'tab_id', '')::uuid INTO v_tip_tab_id
      FROM jsonb_array_elements(v_target) e
     WHERE NULLIF(e->>'tab_id', '') IS NOT NULL
     LIMIT 1;

    INSERT INTO public.payment_tips
      (restaurant_id, tip_cents, method, staff_user_id, tab_id, payment_reference)
    VALUES
      -- payment_tips.method is CHECK (method IN ('cash','card')); a PayToday gratuity is refused at
      -- the route boundary and cannot reach here.
      (p_restaurant_id, v_tip, v_method, p_tip_staff_user_id, v_tip_tab_id, p_payment_reference)
    ON CONFLICT DO NOTHING;
  END IF;

  -- ---- 10. AUDIT METADATA, NAMED FOR WHAT IT IS (F15) --------------------------------------
  --
  -- ONE row for the SETTLEMENT, carrying settlement-level figures under settlement-level names.
  -- The defect being closed is `gatewayAmount: 720` written on a N$500 order because a per-order
  -- audit row was handed a per-settlement figure. `per_order_gateway_amount_cents` is non-null only
  -- when the settlement genuinely is one order, in which case the two numbers are the same one.
  INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_restaurant_id,
    'payment.settlement_applied',
    'payment_settlement',
    COALESCE(p_intent_id::text, v_ref),
    jsonb_build_object(
      'source', p_source,
      'intent_id', p_intent_id,
      'merchant_order_no', p_merchant_order_no,
      'gateway_transaction_id', v_txn,
      'payment_reference', p_payment_reference,
      'payment_method', v_method,
      -- The four figures the brief requires be distinguishable from one another.
      'settlement_gateway_amount_cents', p_gateway_amount_cents,
      'settlement_expected_amount_cents', v_recomputed,
      'settlement_order_count', array_length(p_order_ids, 1),
      'per_order_gateway_amount_cents',
        CASE WHEN array_length(p_order_ids, 1) = 1 THEN p_gateway_amount_cents ELSE NULL END,
      'tip_cents', v_tip,
      -- Intended vs applied, side by side, so invariant 5 is readable straight off the row.
      'intended_order_ids', to_jsonb(p_order_ids),
      'applied_order_ids', to_jsonb(v_claimed),
      'recovered_from_cancelled', to_jsonb(v_recovered),
      'ledger_row_written', v_ledger_rows > 0,
      -- The payment/tab-close race, made visible. A settlement that landed on a tab somebody had
      -- already closed is correct to apply and important to be able to find afterwards.
      'tab_was_closed', v_tab_was_closed,
      'tab_id', v_settle_tab_id,
      'terminal_id', p_terminal_id));

  -- ---- the tab totals ----------------------------------------------------------------------
  --
  -- Recomputed from what is still owed, inside the same transaction. tabs.total is NO LONGER
  -- AUTHORITATIVE for anything (F7) -- lib/tabs/tab-outstanding.ts derives the figure every
  -- financial reader now uses -- but it is kept in step here so the column is not left stale while
  -- it still exists. The status list is OWES_MONEY_PAYMENT_STATUSES: "not paid" would also be true
  -- of a CANCELLED order, which is #104.
  FOREACH v_tab_id IN ARRAY v_tab_ids LOOP
    SELECT COALESCE(sum(total), 0) INTO v_new_total
      FROM public.orders
     WHERE tab_id = v_tab_id
       AND payment_status IN ('unpaid', 'pending', 'cash_pending', 'failed', 'terminal_pending',
                              'amount_mismatch_hold', 'verification_unavailable_hold');
    UPDATE public.tabs SET total = round(v_new_total, 2) WHERE id = v_tab_id;
  END LOOP;

  -- ---- 11. consume the intent --------------------------------------------------------------
  IF p_intent_id IS NOT NULL THEN
    UPDATE public.terminal_payment_intents
       SET status                 = 'confirmed',
           resolved_at            = COALESCE(resolved_at, v_paid_at),
           consumed_at            = v_paid_at,
           gateway_amount_cents   = p_gateway_amount_cents,
           gateway_transaction_id = v_txn,
           gateway_payment_method = v_method,
           settled_order_ids      = p_order_ids
     WHERE id = p_intent_id;
  END IF;

  -- ---- 12. commit.
  --
  -- Every RETURN above this point is reached before the claim loop's first UPDATE, which is what
  -- makes "a refusal writes nothing" true. It is a property of WHERE the returns are, not of what
  -- RETURN does -- see 6b. An exception anywhere aborts the transaction and rolls everything back.
  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'settled',
    'applied', true,
    'intent_id', p_intent_id,
    'claimed_order_ids', to_jsonb(v_claimed),
    'intended_order_ids', to_jsonb(p_order_ids),
    'recovered_order_ids', to_jsonb(v_recovered),
    'expected_amount_cents', v_recomputed,
    'gateway_amount_cents', p_gateway_amount_cents,
    'payment_method', v_method,
    'ledger_row_written', v_ledger_rows > 0,
    'tab_was_closed', v_tab_was_closed);
END;
$$;

ALTER FUNCTION public.settle_order_payment(
  uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_order_payment(
  uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_order_payment(
  uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_order_payment(
  uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)
  TO service_role;
