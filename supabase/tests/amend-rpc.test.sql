-- DATABASE / RPC TESTS for amend_order_lines() -- 20260829150000, redefined by 20260928150000.
--
-- Run by supabase/tests/run-db-tests.mjs AFTER settlement-rpc.test.sql, in the same throwaway
-- database: it reuses that file's `_test_results` table, `_expect()` helper and `_seed()`, and
-- adds its results to the same count. Never against a real database -- these tests INSERT.
--
-- WHY THESE EXIST. Riviera order #160: a tester believed a N$240 pasta was cancelled and it never
-- was. The terminal must treat a line as cancelled ONLY when this function says it applied it
-- (contract C3), so what it reports as `applied` and `refused` has to be exactly what it did --
-- which is what every assertion below checks against the rows, not against the return value alone.
--
-- Same shape as the settlement suite: one function per test, each run in its own subtransaction,
-- every assertion counted.

-- Fixture ids. Restaurant/tab/user come from _seed().
--   R   11111111-1111-4111-8111-111111111111
--   T   22222222-2222-4222-8222-222222222222  (table_number 1)
--   U   55555555-5555-4555-8555-555555555555
--
--   O160  pending order #160, three items:
--         [0] Modena Pasta  x2  N$240  -> L_PASTA  kitchen outstanding
--         [1] Lager         x3  N$90   -> L_BEER   bar outstanding
--         [2] Steak         x1  N$70   -> L_STEAK  kitchen COOKED (window closed)
--   O161  PAID order #161:     [0] Salad x1 N$50 -> L_PAID  kitchen outstanding
--   O162  pending order #162:  [0] Wine x2 N$80  -> L_SPLIT bar outstanding, allocation SETTLED
--                              [1] Soup x1 N$40  -> L_ALLOC kitchen outstanding, allocation UNSETTLED
CREATE OR REPLACE FUNCTION public._seed_amend()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  UPDATE public.tabs SET table_number = 1, status = 'open'
   WHERE id = '22222222-2222-4222-8222-222222222222';

  INSERT INTO public.orders
    (id, restaurant_id, firebase_restaurant_id, tab_id, table_number, order_number, status,
     payment_status, payment_method, channel, subtotal, tax, total, items)
  VALUES
    ('bbbbbbbb-0000-4000-8000-000000000160', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 160,
     'pending', 'pending', 'cash', 'pos', 347.83, 52.17, 400,
     '[{"name":"Modena Pasta","quantity":2,"price":120,"subtotal":208.70,"tax":31.30,"total":240},
       {"name":"Lager","quantity":3,"price":30,"subtotal":78.26,"tax":11.74,"total":90},
       {"name":"Steak","quantity":1,"price":70,"subtotal":60.87,"tax":9.13,"total":70}]'::jsonb),
    ('bbbbbbbb-0000-4000-8000-000000000161', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 161,
     'completed', 'paid', 'card', 'pos', 43.48, 6.52, 50,
     '[{"name":"Salad","quantity":1,"price":50,"subtotal":43.48,"tax":6.52,"total":50}]'::jsonb),
    ('bbbbbbbb-0000-4000-8000-000000000162', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 162,
     'pending', 'pending', 'cash', 'pos', 104.35, 15.65, 120,
     '[{"name":"Wine","quantity":2,"price":40,"subtotal":69.57,"tax":10.43,"total":80},
       {"name":"Soup","quantity":1,"price":40,"subtotal":34.78,"tax":5.22,"total":40}]'::jsonb);

  INSERT INTO public.order_lines
    (id, restaurant_id, order_id, tab_id, source_item_index, name_snapshot, quantity, line_note,
     route_to, kitchen_state, bar_state)
  VALUES
    ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000160', '22222222-2222-4222-8222-222222222222', 0,
     'Modena Pasta', 2, 'no parmesan', 'kitchen', 'outstanding', NULL),
    ('cccccccc-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000160', '22222222-2222-4222-8222-222222222222', 1,
     'Lager', 3, NULL, 'bar', NULL, 'outstanding'),
    ('cccccccc-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000160', '22222222-2222-4222-8222-222222222222', 2,
     'Steak', 1, NULL, 'kitchen', 'cooked', NULL),
    ('cccccccc-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000161', '22222222-2222-4222-8222-222222222222', 0,
     'Salad', 1, NULL, 'kitchen', 'outstanding', NULL),
    ('cccccccc-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000162', '22222222-2222-4222-8222-222222222222', 0,
     'Wine', 2, NULL, 'bar', NULL, 'outstanding'),
    ('cccccccc-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000162', '22222222-2222-4222-8222-222222222222', 1,
     'Soup', 1, NULL, 'kitchen', 'outstanding', NULL);

  -- L_SPLIT: half the wine allocated to guest-1 AND SETTLED (claimed + ledger row).
  INSERT INTO public.order_line_allocations
    (id, restaurant_id, order_id, order_line_id, tab_id, allocated_to, quantity_allocated,
     amount_cents, created_by_actor_kind, settled_at)
  VALUES
    ('dddddddd-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000162', 'cccccccc-0000-4000-8000-000000000005',
     '22222222-2222-4222-8222-222222222222', 'guest-1', 1, 4000, 'terminal', now()),
    -- L_ALLOC: allocated but NOT settled -- no money taken, so the void must still go through.
    ('dddddddd-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000162', 'cccccccc-0000-4000-8000-000000000006',
     '22222222-2222-4222-8222-222222222222', 'guest-2', 1, 4000, 'terminal', NULL);
  INSERT INTO public.order_line_allocation_settlements
    (restaurant_id, order_line_allocation_id, tab_id, amount_cents, method)
  VALUES
    ('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000005',
     '22222222-2222-4222-8222-222222222222', 4000, 'cash');
END;
$$;

-- The call every test makes. Order number 900 unless stated.
CREATE OR REPLACE FUNCTION public._amend(p_amendments jsonb, p_order_number integer DEFAULT 900)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.amend_order_lines(
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    p_order_number, 'terminal', '55555555-5555-4555-8555-555555555555'::uuid, p_amendments);
$$;

CREATE OR REPLACE FUNCTION public._refusal(p_result jsonb, p_line uuid)
RETURNS text LANGUAGE sql AS $$
  SELECT r->>'reason' FROM jsonb_array_elements(p_result->'refused') r
   WHERE (r->>'line_id')::uuid = p_line LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._line_state(p_line uuid)
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(kitchen_state, '-') || '/' || COALESCE(bar_state, '-')
    FROM public.order_lines WHERE id = p_line;
$$;

CREATE OR REPLACE FUNCTION public._void_events(p_line uuid)
RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM public.order_line_events
   WHERE order_line_id = p_line AND to_state = 'voided';
$$;

-- ==================================================================================================
-- A1. A full void: reported applied/voided, the line IS voided, one attributed event, no new order.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_void()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  ev record;
BEGIN
  PERFORM public._seed_amend();
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]');

  PERFORM public._expect('amend_void/applied_voided',
    r->'applied' = '[{"line_id":"cccccccc-0000-4000-8000-000000000001","action":"voided"}]'::jsonb,
    r::text);
  PERFORM public._expect('amend_void/nothing_refused', jsonb_array_length(r->'refused') = 0, r::text);
  PERFORM public._expect('amend_void/no_replacement_order', r->>'order_id' IS NULL, r::text);
  PERFORM public._expect('amend_void/line_is_voided',
    public._line_state('cccccccc-0000-4000-8000-000000000001') = 'voided/-',
    public._line_state('cccccccc-0000-4000-8000-000000000001'));

  SELECT count(*) AS n, min(station) AS station, min(from_state) AS from_state,
         min(actor_kind) AS actor_kind, min(actor_user_id::text) AS actor
    INTO ev FROM public.order_line_events
   WHERE order_line_id = 'cccccccc-0000-4000-8000-000000000001' AND to_state = 'voided';
  PERFORM public._expect('amend_void/one_event_attributed',
    ev.n = 1 AND ev.station = 'kitchen' AND ev.from_state = 'outstanding'
      AND ev.actor_kind = 'terminal' AND ev.actor = '55555555-5555-4555-8555-555555555555',
    format('%s events, %s %s %s %s', ev.n, ev.station, ev.from_state, ev.actor_kind, ev.actor));
  PERFORM public._expect('amend_void/no_order_created',
    (SELECT count(*) FROM public.orders) = 3, NULL);
END;
$$;

-- ==================================================================================================
-- A2. A reduction: old line voided, replacement order + line with the scaled item and total.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_reduce()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  o record;
  nl record;
  new_line uuid;
BEGIN
  PERFORM public._seed_amend();
  -- An UNSETTLED split of the lagers, which the reduction must void along with the line.
  INSERT INTO public.order_line_allocations
    (id, restaurant_id, order_id, order_line_id, tab_id, allocated_to, quantity_allocated,
     amount_cents, created_by_actor_kind)
  VALUES
    ('dddddddd-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000160', 'cccccccc-0000-4000-8000-000000000002',
     '22222222-2222-4222-8222-222222222222', 'guest-3', 3, 9000, 'terminal');
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000002","new_quantity":1}]', 901);
  PERFORM public._expect('amend_alloc/reduction_voids_allocation',
    (SELECT voided_at IS NOT NULL AND void_reason = 'line_voided_by_amendment'
       FROM public.order_line_allocations WHERE id = 'dddddddd-0000-4000-8000-000000000002'), NULL);

  PERFORM public._expect('amend_reduce/applied_replaced',
    jsonb_array_length(r->'applied') = 1
      AND r->'applied'->0->>'line_id' = 'cccccccc-0000-4000-8000-000000000002'
      AND r->'applied'->0->>'action' = 'replaced'
      AND r->'applied'->0->>'new_line_id' IS NOT NULL,
    r::text);
  new_line := (r->'applied'->0->>'new_line_id')::uuid;

  PERFORM public._expect('amend_reduce/old_line_voided',
    public._line_state('cccccccc-0000-4000-8000-000000000002') = '-/voided',
    public._line_state('cccccccc-0000-4000-8000-000000000002'));

  SELECT * INTO o FROM public.orders WHERE id = (r->>'order_id')::uuid;
  PERFORM public._expect('amend_reduce/replacement_order',
    o.order_number = 901 AND (r->>'order_number')::integer = 901
      AND o.status = 'pending' AND o.payment_status = 'pending' AND o.channel = 'pos'
      AND o.tab_id = '22222222-2222-4222-8222-222222222222' AND o.table_number = 1,
    format('#%s %s/%s %s tab=%s table=%s', o.order_number, o.status, o.payment_status, o.channel,
           o.tab_id, o.table_number));
  -- 3 lagers for N$90 reduced to 1 is N$30, scaled from the ORIGINAL item, never re-priced.
  PERFORM public._expect('amend_reduce/replacement_total_scaled',
    o.total = 30 AND o.subtotal = 26.09 AND o.tax = 3.91
      AND jsonb_array_length(o.items) = 1
      AND o.items->0->>'name' = 'Lager'
      AND (o.items->0->>'quantity')::numeric = 1
      AND (o.items->0->>'total')::numeric = 30
      AND (o.items->0->>'price')::numeric = 30,
    format('total=%s subtotal=%s tax=%s items=%s', o.total, o.subtotal, o.tax, o.items));

  SELECT * INTO nl FROM public.order_lines WHERE id = new_line;
  PERFORM public._expect('amend_reduce/replacement_line',
    nl.order_id = o.id AND nl.quantity = 1 AND nl.name_snapshot = 'Lager'
      AND nl.source_item_index = 0 AND nl.route_to = 'bar'
      AND nl.bar_state = 'outstanding' AND nl.kitchen_state IS NULL,
    format('%s', row_to_json(nl)));
  PERFORM public._expect('amend_reduce/events',
    public._void_events('cccccccc-0000-4000-8000-000000000002') = 1
      AND (SELECT count(*) FROM public.order_line_events
            WHERE order_line_id = new_line AND from_state IS NULL AND to_state = 'outstanding') = 1,
    NULL);
  -- The original order is untouched: its total stays what the customer was billed at the time
  -- (the financial projection subtracts the voided line; nothing rewrites the figure).
  PERFORM public._expect('amend_reduce/original_total_unchanged',
    (SELECT total FROM public.orders WHERE id = 'bbbbbbbb-0000-4000-8000-000000000160') = 400, NULL);
END;
$$;

-- ==================================================================================================
-- A3. Window closed: a cooked line is refused and NOTHING about it changes.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_window_closed()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
BEGIN
  PERFORM public._seed_amend();
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000003","new_quantity":0}]');
  PERFORM public._expect('amend_window/refused_window_closed',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000003') = 'window_closed'
      AND jsonb_array_length(r->'applied') = 0 AND r->>'order_id' IS NULL,
    r::text);
  PERFORM public._expect('amend_window/line_still_cooked',
    public._line_state('cccccccc-0000-4000-8000-000000000003') = 'cooked/-',
    public._line_state('cccccccc-0000-4000-8000-000000000003'));
  PERFORM public._expect('amend_window/no_event',
    (SELECT count(*) FROM public.order_line_events) = 0, NULL);
END;
$$;

-- ==================================================================================================
-- A4. An already-voided line: the second void is refused, and there is still exactly one event.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_already_voided()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r1 jsonb;
  r2 jsonb;
BEGIN
  PERFORM public._seed_amend();
  r1 := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]');
  r2 := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]', 902);
  PERFORM public._expect('amend_revoid/first_applied',
    jsonb_array_length(r1->'applied') = 1, r1::text);
  PERFORM public._expect('amend_revoid/second_refused',
    jsonb_array_length(r2->'applied') = 0
      AND public._refusal(r2, 'cccccccc-0000-4000-8000-000000000001') = 'window_closed',
    r2::text);
  PERFORM public._expect('amend_revoid/one_void_event',
    public._void_events('cccccccc-0000-4000-8000-000000000001') = 1,
    public._void_events('cccccccc-0000-4000-8000-000000000001')::text);
  -- A REDUCTION of a voided line must not resurrect it on a new order either.
  r2 := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":1}]', 903);
  PERFORM public._expect('amend_revoid/reduce_of_voided_refused',
    jsonb_array_length(r2->'applied') = 0 AND r2->>'order_id' IS NULL
      AND (SELECT count(*) FROM public.orders) = 3,
    r2::text);
END;
$$;

-- ==================================================================================================
-- A5. order_paid: a void AND a reduction on a paid order are refused; nothing is written.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_order_paid()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
BEGIN
  PERFORM public._seed_amend();
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000004","new_quantity":0}]');
  PERFORM public._expect('amend_paid/void_refused_order_paid',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000004') = 'order_paid'
      AND jsonb_array_length(r->'applied') = 0,
    r::text);
  PERFORM public._expect('amend_paid/line_untouched',
    public._line_state('cccccccc-0000-4000-8000-000000000004') = 'outstanding/-'
      AND public._void_events('cccccccc-0000-4000-8000-000000000004') = 0,
    public._line_state('cccccccc-0000-4000-8000-000000000004'));

  -- The reduction is the worse half of the defect: it would re-bill the surviving unit.
  UPDATE public.orders SET items = '[{"name":"Salad","quantity":2,"price":25,"total":50}]'::jsonb
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000161';
  UPDATE public.order_lines SET quantity = 2 WHERE id = 'cccccccc-0000-4000-8000-000000000004';
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000004","new_quantity":1}]', 904);
  PERFORM public._expect('amend_paid/reduction_refused_no_rebill',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000004') = 'order_paid'
      AND r->>'order_id' IS NULL
      AND (SELECT count(*) FROM public.orders WHERE order_number = 904) = 0,
    r::text);
  -- (The trimmed/case-insensitive half of the predicate cannot be exercised here:
  -- orders_payment_status_enumerated, 20260919091000, rejects any spelling but 'paid'.)
END;
$$;

-- ==================================================================================================
-- A6. line_settled: a line with a settled allocation is refused; an UNSETTLED allocation, and a
--     settled one that was itself voided, do not block (positive controls -- the guard must not
--     refuse everything that has an allocation).
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_line_settled()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
BEGIN
  PERFORM public._seed_amend();
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000005","new_quantity":1}]');
  PERFORM public._expect('amend_settled/refused_line_settled',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000005') = 'line_settled'
      AND jsonb_array_length(r->'applied') = 0 AND r->>'order_id' IS NULL,
    r::text);
  PERFORM public._expect('amend_settled/line_untouched',
    public._line_state('cccccccc-0000-4000-8000-000000000005') = '-/outstanding', NULL);

  -- The ledger row alone (settled_at not stamped) still counts as settled.
  UPDATE public.order_line_allocations SET settled_at = NULL
   WHERE id = 'dddddddd-0000-4000-8000-000000000005';
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000005","new_quantity":0}]', 906);
  PERFORM public._expect('amend_settled/ledger_row_counts',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000005') = 'line_settled', r::text);

  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000006","new_quantity":0}]', 907);
  PERFORM public._expect('amend_settled/unsettled_allocation_does_not_block',
    r->'applied'->0->>'line_id' = 'cccccccc-0000-4000-8000-000000000006'
      AND public._line_state('cccccccc-0000-4000-8000-000000000006') = 'voided/-',
    r::text);
  -- The money-flow audit's defect: a voided line's unsettled allocation stayed chargeable.
  PERFORM public._expect('amend_alloc/voided_with_line',
    (SELECT voided_at IS NOT NULL AND void_reason = 'line_voided_by_amendment' AND settled_at IS NULL
       FROM public.order_line_allocations WHERE id = 'dddddddd-0000-4000-8000-000000000006'),
    (SELECT row_to_json(a)::text FROM public.order_line_allocations a
      WHERE id = 'dddddddd-0000-4000-8000-000000000006'));
  -- ...and ONLY that line's: the settled allocation on the refused wine line is untouched.
  PERFORM public._expect('amend_alloc/other_lines_untouched',
    (SELECT voided_at IS NULL FROM public.order_line_allocations
      WHERE id = 'dddddddd-0000-4000-8000-000000000005'), NULL);

  UPDATE public.order_line_allocations SET voided_at = now(), settled_at = now()
   WHERE id = 'dddddddd-0000-4000-8000-000000000005';
  DELETE FROM public.order_line_allocation_settlements
   WHERE order_line_allocation_id = 'dddddddd-0000-4000-8000-000000000005';
  r := public._amend('[{"line_id":"cccccccc-0000-4000-8000-000000000005","new_quantity":0}]', 908);
  PERFORM public._expect('amend_settled/voided_allocation_does_not_block',
    jsonb_array_length(r->'applied') = 1, r::text);
END;
$$;

-- ==================================================================================================
-- A7. A mixed call. The function's semantics are PER LINE: a refused line never blocks the others.
--     Asserted exactly, so a caller (the route, the terminal) can rely on applied/refused
--     partitioning every requested line with nothing half-applied.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_mixed()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  applied_ids text[];
BEGIN
  PERFORM public._seed_amend();
  r := public._amend('[
    {"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0},
    {"line_id":"cccccccc-0000-4000-8000-000000000003","new_quantity":0},
    {"line_id":"cccccccc-0000-4000-8000-000000000004","new_quantity":0},
    {"line_id":"cccccccc-0000-4000-8000-000000000005","new_quantity":0},
    {"line_id":"cccccccc-0000-4000-8000-0000000000ff","new_quantity":0},
    {"line_id":"cccccccc-0000-4000-8000-000000000002","new_quantity":2}
  ]'::jsonb, 910);

  SELECT array_agg(a->>'line_id' ORDER BY a->>'line_id') INTO applied_ids
    FROM jsonb_array_elements(r->'applied') a;
  PERFORM public._expect('amend_mixed/applied_exactly',
    applied_ids = ARRAY['cccccccc-0000-4000-8000-000000000001',
                        'cccccccc-0000-4000-8000-000000000002'],
    r::text);
  PERFORM public._expect('amend_mixed/refusals_named',
    public._refusal(r, 'cccccccc-0000-4000-8000-000000000003') = 'window_closed'
      AND public._refusal(r, 'cccccccc-0000-4000-8000-000000000004') = 'order_paid'
      AND public._refusal(r, 'cccccccc-0000-4000-8000-000000000005') = 'line_settled'
      AND public._refusal(r, 'cccccccc-0000-4000-8000-0000000000ff') = 'not_found'
      AND jsonb_array_length(r->'refused') = 4,
    r::text);
  PERFORM public._expect('amend_mixed/rows_match_report',
    public._line_state('cccccccc-0000-4000-8000-000000000001') = 'voided/-'
      AND public._line_state('cccccccc-0000-4000-8000-000000000002') = '-/voided'
      AND public._line_state('cccccccc-0000-4000-8000-000000000003') = 'cooked/-'
      AND public._line_state('cccccccc-0000-4000-8000-000000000004') = 'outstanding/-'
      AND public._line_state('cccccccc-0000-4000-8000-000000000005') = '-/outstanding'
      AND (SELECT count(*) FROM public.order_line_events WHERE to_state = 'voided') = 2,
    NULL);
  PERFORM public._expect('amend_mixed/one_replacement_order_with_lager_x2',
    (SELECT count(*) FROM public.orders WHERE order_number = 910) = 1
      AND (SELECT total FROM public.orders WHERE order_number = 910) = 60,
    NULL);
END;
$$;

-- ==================================================================================================
-- A8. ATOMICITY. When the function RAISES, nothing it did earlier in the same call survives.
--     Two ways to raise: the order number is taken (the route retries on exactly this), and a
--     replacement whose source item is missing.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_atomic()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  raised boolean;
BEGIN
  PERFORM public._seed_amend();

  -- Line 1 is a pure void (written before the replacement insert); line 2 needs a replacement
  -- order, numbered 160 -- which order #160 already holds.
  raised := false;
  BEGIN
    PERFORM public._amend('[
      {"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0},
      {"line_id":"cccccccc-0000-4000-8000-000000000002","new_quantity":1}
    ]'::jsonb, 160);
  EXCEPTION WHEN unique_violation THEN
    raised := true;
  END;
  PERFORM public._expect('amend_atomic/collision_raises', raised, NULL);
  PERFORM public._expect('amend_atomic/collision_voided_nothing',
    public._line_state('cccccccc-0000-4000-8000-000000000001') = 'outstanding/-'
      AND public._line_state('cccccccc-0000-4000-8000-000000000002') = '-/outstanding'
      AND (SELECT count(*) FROM public.order_line_events) = 0
      AND (SELECT count(*) FROM public.orders) = 3,
    public._line_state('cccccccc-0000-4000-8000-000000000001'));

  -- A source item that no longer exists: raise, and the void of line 1 before it rolls back.
  UPDATE public.order_lines SET source_item_index = 7 WHERE id = 'cccccccc-0000-4000-8000-000000000002';
  raised := false;
  BEGIN
    PERFORM public._amend('[
      {"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0},
      {"line_id":"cccccccc-0000-4000-8000-000000000002","new_quantity":1}
    ]'::jsonb, 911);
  EXCEPTION WHEN OTHERS THEN
    raised := true;
  END;
  PERFORM public._expect('amend_atomic/missing_source_raises', raised, NULL);
  PERFORM public._expect('amend_atomic/missing_source_voided_nothing',
    public._line_state('cccccccc-0000-4000-8000-000000000001') = 'outstanding/-'
      AND (SELECT count(*) FROM public.order_line_events) = 0,
    public._line_state('cccccccc-0000-4000-8000-000000000001'));
END;
$$;

-- ==================================================================================================
-- A9. Tenant scope: another restaurant's tab is an exception, and nothing is voided.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_scope()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  raised boolean := false;
BEGIN
  PERFORM public._seed_amend();
  BEGIN
    PERFORM public.amend_order_lines(
      '99999999-9999-4999-8999-999999999999'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
      950, 'terminal', NULL,
      '[{"line_id":"cccccccc-0000-4000-8000-000000000001","new_quantity":0}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    raised := true;
  END;
  PERFORM public._expect('amend_scope/other_restaurant_refused',
    raised AND public._line_state('cccccccc-0000-4000-8000-000000000001') = 'outstanding/-', NULL);
END;
$$;

-- ==================================================================================================
-- A10. Grants: identical to the original -- service_role only.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_amend_grants()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  sig text := 'public.amend_order_lines(uuid, uuid, integer, text, uuid, jsonb)';
BEGIN
  PERFORM public._expect('amend_security/one_definition',
    (SELECT count(*) FROM pg_proc WHERE proname = 'amend_order_lines') = 1,
    'an overload of amend_order_lines exists');
  PERFORM public._expect('amend_security/security_definer',
    (SELECT prosecdef FROM pg_proc WHERE oid = sig::regprocedure), NULL);
  PERFORM public._expect('amend_security/anon_cannot_execute',
    NOT has_function_privilege('anon', sig, 'EXECUTE'), NULL);
  PERFORM public._expect('amend_security/authenticated_cannot_execute',
    NOT has_function_privilege('authenticated', sig, 'EXECUTE'), NULL);
  PERFORM public._expect('amend_security/public_cannot_execute',
    NOT has_function_privilege('public', sig, 'EXECUTE'), NULL);
  PERFORM public._expect('amend_security/service_role_can_execute',
    has_function_privilege('service_role', sig, 'EXECUTE'), NULL);
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_amend_void',
    '_t_amend_reduce',
    '_t_amend_window_closed',
    '_t_amend_already_voided',
    '_t_amend_order_paid',
    '_t_amend_line_settled',
    '_t_amend_mixed',
    '_t_amend_atomic',
    '_t_amend_scope',
    '_t_amend_grants'
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
