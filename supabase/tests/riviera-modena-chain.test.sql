-- RIVIERA #160, THE MODENA SEQUENCE, AGAINST THE REAL amend_order_lines AND settle_order_payment.
--
-- Run by supabase/tests/run-db-tests.mjs AFTER amend-rpc.test.sql, in the same throwaway database:
-- it reuses settlement-rpc.test.sql's `_test_results`, `_expect()` and `_seed()`. Never against a
-- real database -- these tests INSERT.
--
-- WHAT THIS FILE ADDS OVER amend-rpc.test.sql. That file proves each refusal and each write of the
-- RPC on a small three-item order. This one walks the ACTUAL incident, end to end, in money:
--
--   #160 as placed    Modena 240 · 2x WYWH 380 · 2x Salmon 920 · 2x Burger 180 · Jameson 80
--                     · Hansa 80 · Soft Drinks 35 · Mixers 30                      = N$1,945
--   three reductions  WYWH 2->1, Burger 2->1, Salmon 2->1 (each voids the whole original line and
--                     puts the surviving unit on a replacement order #161/#162/#163)  live N$1,205
--   A. Modena void    applied            -> live N$965, and a card settlement of N$965 is accepted
--                                           while one of N$1,205 is refused
--   B. Modena cooked  refused (window_closed) -> live stays N$1,205, nothing about Modena moves
--
-- "Live" is read here by an INDEPENDENT SQL reading of the C1 rule (original − Σ voided items, 0 if
-- cancelled), so the figures are not merely whatever lib/orders/order-financials.ts says -- the
-- jest chain (__tests__/e2e-riviera-modena-chain.test.ts) asserts the TypeScript projection lands
-- on the same numbers over the SAME rows.
--
-- THE SNAPSHOT. `_modena_snapshot()` replays both branches and returns every row the RPCs wrote.
-- The runner normalises the generated ids and compares it with the committed
-- __tests__/fixtures/riviera-modena-rpc-snapshot.json, which the jest chain replays as the RPC's
-- answer. So the routes are tested against rows the real functions produced, and a change to
-- either function that moves those rows fails the DB suite until the fixture is regenerated
-- (`node supabase/tests/run-db-tests.mjs --write-modena-snapshot`) -- at which point the jest
-- chain re-runs against the new truth.

-- Fixture ids. Restaurant/tab/user come from _seed():
--   R 11111111-1111-4111-8111-111111111111   T 22222222-2222-4222-8222-222222222222
--   U 55555555-5555-4555-8555-555555555555 (the PIN-verified manager on every void)
-- Order #160 eeeeeeee-0000-4000-8000-000000000160; lines eeeeeeee-0000-4000-8000-0000000001a0..a7
-- (index 0..7). Menu item ids dddddddd-...-0000000001d0..d7. VAT rate abab0001-...-000000000015.

CREATE OR REPLACE FUNCTION public._seed_modena()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  UPDATE public.tabs SET table_number = 1, status = 'open', total = 1945
   WHERE id = '22222222-2222-4222-8222-222222222222';

  -- The items in the shape calculateOrderPricing stores: VAT-inclusive totals at 15%, with
  -- subtotal/tax split per line (they sum to the order's subtotal/tax).
  INSERT INTO public.orders
    (id, restaurant_id, firebase_restaurant_id, tab_id, table_number, order_number, status,
     payment_status, payment_method, channel, subtotal, tax, total, items, placed_at)
  VALUES
    ('eeeeeeee-0000-4000-8000-000000000160', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 160,
     'pending', 'pending', 'cash', 'pos', 1691.31, 253.69, 1945,
     '[{"menuItemId":"dddddddd-0000-4000-8000-0000000001d0","name":"Modena Pasta","quantity":1,"unitPrice":240,"subtotal":208.70,"tax":31.30,"total":240,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"kitchen"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d1","name":"Wish You Were Here","quantity":2,"unitPrice":190,"subtotal":330.43,"tax":49.57,"total":380,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"kitchen"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d2","name":"Seared Salmon","quantity":2,"unitPrice":460,"subtotal":800.00,"tax":120.00,"total":920,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"kitchen"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d3","name":"Double Cheese Burger","quantity":2,"unitPrice":90,"subtotal":156.52,"tax":23.48,"total":180,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"kitchen"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d4","name":"Jameson","quantity":1,"unitPrice":80,"subtotal":69.57,"tax":10.43,"total":80,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"bar"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d5","name":"Hansa","quantity":1,"unitPrice":80,"subtotal":69.57,"tax":10.43,"total":80,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"bar"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d6","name":"Soft Drinks","quantity":1,"unitPrice":35,"subtotal":30.43,"tax":4.57,"total":35,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"bar"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d7","name":"Mixers","quantity":1,"unitPrice":30,"subtotal":26.09,"tax":3.91,"total":30,"taxRateId":"abab0001-0000-4000-8000-000000000015","route_to":"bar"}]'::jsonb,
     '2026-09-24T18:00:00Z');

  INSERT INTO public.order_lines
    (id, restaurant_id, order_id, tab_id, source_item_index, name_snapshot, quantity, line_note,
     route_to, kitchen_state, bar_state)
  SELECT ('eeeeeeee-0000-4000-8000-0000000001a' || i)::uuid,
         '11111111-1111-4111-8111-111111111111', 'eeeeeeee-0000-4000-8000-000000000160',
         '22222222-2222-4222-8222-222222222222', i,
         (o.items -> i ->> 'name'), (o.items -> i ->> 'quantity')::numeric, NULL,
         (o.items -> i ->> 'route_to'),
         CASE WHEN o.items -> i ->> 'route_to' = 'kitchen' THEN 'outstanding' END,
         CASE WHEN o.items -> i ->> 'route_to' = 'bar' THEN 'outstanding' END
    FROM generate_series(0, 7) AS i
    CROSS JOIN public.orders o
   WHERE o.id = 'eeeeeeee-0000-4000-8000-000000000160';
END;
$$;

-- One amendment of one line, as the amend route calls it: actor = the PIN-verified manager.
CREATE OR REPLACE FUNCTION public._modena_amend(p_line uuid, p_quantity integer, p_order_number integer)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.amend_order_lines(
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    p_order_number, 'terminal', '55555555-5555-4555-8555-555555555555'::uuid,
    jsonb_build_array(jsonb_build_object('line_id', p_line, 'new_quantity', p_quantity)));
$$;

-- The three reductions production recorded before the Modena attempt.
CREATE OR REPLACE FUNCTION public._modena_reduce_three()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  out jsonb := '[]'::jsonb;
BEGIN
  out := out || jsonb_build_array(public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a1', 1, 161));
  out := out || jsonb_build_array(public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a3', 1, 162));
  out := out || jsonb_build_array(public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a2', 1, 163));
  RETURN out;
END;
$$;

-- AN INDEPENDENT READING OF C1 "live": original − Σ items[i].total over lines voided on every
-- owning station; 0 for a cancelled order. Integer cents.
CREATE OR REPLACE FUNCTION public._modena_live_cents(p_order uuid)
RETURNS integer LANGUAGE sql AS $$
  SELECT CASE WHEN lower(COALESCE(o.status, '')) = 'cancelled' THEN 0 ELSE GREATEST(0,
           round(o.total * 100)::integer - COALESCE((
             SELECT sum(round((o.items -> l.source_item_index ->> 'total')::numeric * 100))::integer
               FROM public.order_lines l
              WHERE l.order_id = o.id
                AND (l.kitchen_state IS NOT NULL OR l.bar_state IS NOT NULL)
                AND COALESCE(l.kitchen_state, 'voided') = 'voided'
                AND COALESCE(l.bar_state, 'voided') = 'voided'), 0)) END
    FROM public.orders o WHERE o.id = p_order;
$$;

CREATE OR REPLACE FUNCTION public._modena_tab_live_cents()
RETURNS integer LANGUAGE sql AS $$
  SELECT COALESCE(sum(public._modena_live_cents(id)), 0)::integer
    FROM public.orders WHERE tab_id = '22222222-2222-4222-8222-222222222222';
$$;

CREATE OR REPLACE FUNCTION public._modena_order_id(p_number integer)
RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.orders
   WHERE tab_id = '22222222-2222-4222-8222-222222222222' AND order_number = p_number;
$$;

CREATE OR REPLACE FUNCTION public._modena_order_ids()
RETURNS uuid[] LANGUAGE sql AS $$
  SELECT array_agg(id ORDER BY order_number) FROM public.orders
   WHERE tab_id = '22222222-2222-4222-8222-222222222222';
$$;

-- What prepare-payment writes before the reader is launched: each order's OWN live outstanding
-- figure, and one settlement id across the set. The jest chain asserts the real route writes
-- exactly these numbers over the same rows.
CREATE OR REPLACE FUNCTION public._modena_prepare()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_total integer;
BEGIN
  UPDATE public.orders
     SET pending_charge_cents = NULLIF(public._modena_live_cents(id), 0),
         pending_settlement_id = '66666666-6666-4666-8666-666666666666'
   WHERE tab_id = '22222222-2222-4222-8222-222222222222';
  SELECT sum(pending_charge_cents)::integer INTO v_total
    FROM public.orders WHERE tab_id = '22222222-2222-4222-8222-222222222222';
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public._modena_settle(p_gateway_cents integer)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111', public._modena_order_ids(),
    p_gateway_cents, p_gateway_cents, 'TXN-MODENA-1', 'MO-MODENA-1', 'card', 'MO-MODENA-1', NULL,
    'paycloud_webhook_fallback_finatic_verified', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.39');
$$;

-- ==================================================================================================
-- M1. The three reductions: N$1,945 as placed becomes N$1,205 live, per order and for the tab.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_modena_reductions()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  steps jsonb;
BEGIN
  PERFORM public._seed_modena();
  PERFORM public._expect('modena/as_placed_1945', public._modena_tab_live_cents() = 194500,
    public._modena_tab_live_cents()::text);

  steps := public._modena_reduce_three();
  PERFORM public._expect('modena/reductions_all_applied',
    (SELECT bool_and(jsonb_array_length(s->'applied') = 1 AND s->'applied'->0->>'action' = 'replaced')
       FROM jsonb_array_elements(steps) s),
    steps::text);
  PERFORM public._expect('modena/replacement_orders',
    (SELECT array_agg(order_number || ':' || total ORDER BY order_number) FROM public.orders)
      = ARRAY['160:1945', '161:190.00', '162:90.00', '163:460.00'],
    (SELECT array_agg(order_number || ':' || total ORDER BY order_number) FROM public.orders)::text);
  PERFORM public._expect('modena/live_per_order_after_reductions',
    public._modena_live_cents(public._modena_order_id(160)) = 46500
      AND public._modena_live_cents(public._modena_order_id(161)) = 19000
      AND public._modena_live_cents(public._modena_order_id(162)) = 9000
      AND public._modena_live_cents(public._modena_order_id(163)) = 46000,
    format('%s %s %s %s', public._modena_live_cents(public._modena_order_id(160)),
      public._modena_live_cents(public._modena_order_id(161)),
      public._modena_live_cents(public._modena_order_id(162)),
      public._modena_live_cents(public._modena_order_id(163))));
  PERFORM public._expect('modena/live_1205', public._modena_tab_live_cents() = 120500,
    public._modena_tab_live_cents()::text);
  PERFORM public._expect('modena/original_total_never_rewritten',
    (SELECT total FROM public.orders WHERE order_number = 160) = 1945, NULL);
END;
$$;

-- ==================================================================================================
-- M2. A: the Modena cancellation is APPLIED. Live N$965; the line and its event say so; the card
--     settlement at N$965 is accepted and records N$965 on the ledger and per order.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_modena_void_applied()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  s jsonb;
  ev record;
  n_events integer;
BEGIN
  PERFORM public._seed_modena();
  PERFORM public._modena_reduce_three();
  r := public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a0', 0, 164);

  PERFORM public._expect('modena_void/applied_voided',
    r->'applied' = '[{"line_id":"eeeeeeee-0000-4000-8000-0000000001a0","action":"voided"}]'::jsonb
      AND jsonb_array_length(r->'refused') = 0 AND r->>'order_id' IS NULL,
    r::text);
  PERFORM public._expect('modena_void/kitchen_state_voided',
    (SELECT kitchen_state = 'voided' AND bar_state IS NULL FROM public.order_lines
      WHERE id = 'eeeeeeee-0000-4000-8000-0000000001a0'), NULL);
  SELECT count(*) AS n, min(from_state) AS from_state, min(actor_kind) AS kind,
         min(actor_user_id::text) AS actor
    INTO ev FROM public.order_line_events
   WHERE order_line_id = 'eeeeeeee-0000-4000-8000-0000000001a0' AND to_state = 'voided';
  PERFORM public._expect('modena_void/one_attributed_void_event',
    ev.n = 1 AND ev.from_state = 'outstanding' AND ev.kind = 'terminal'
      AND ev.actor = '55555555-5555-4555-8555-555555555555',
    format('%s %s %s %s', ev.n, ev.from_state, ev.kind, ev.actor));
  PERFORM public._expect('modena_void/no_replacement_order',
    (SELECT count(*) FROM public.orders) = 4, NULL);
  PERFORM public._expect('modena_void/live_965', public._modena_tab_live_cents() = 96500,
    public._modena_tab_live_cents()::text);
  PERFORM public._expect('modena_void/order_160_live_225',
    public._modena_live_cents(public._modena_order_id(160)) = 22500,
    public._modena_live_cents(public._modena_order_id(160))::text);

  PERFORM public._expect('modena_void/prepare_writes_965', public._modena_prepare() = 96500, NULL);
  s := public._modena_settle(96500);
  PERFORM public._expect('modena_void/settle_965_ok', (s->>'ok')::boolean, s::text);
  PERFORM public._expect('modena_void/all_four_paid',
    (SELECT count(*) FROM public.orders WHERE payment_status = 'paid') = 4, NULL);
  PERFORM public._expect('modena_void/settled_charge_is_live_per_order',
    (SELECT array_agg(settled_charge_cents ORDER BY order_number) FROM public.orders)
      = ARRAY[22500, 19000, 9000, 46000],
    (SELECT array_agg(settled_charge_cents ORDER BY order_number) FROM public.orders)::text);
  SELECT count(*) INTO n_events FROM public.payment_events WHERE event_type = 'sale';
  PERFORM public._expect('modena_void/ledger_is_965',
    n_events = 1 AND (SELECT amount FROM public.payment_events WHERE event_type = 'sale') = 965,
    format('%s sale events, amount %s', n_events,
      (SELECT amount FROM public.payment_events WHERE event_type = 'sale')));
END;
$$;

-- ==================================================================================================
-- M3. The stale figure: after the void, a gateway amount of N$1,205 (what the bill said before
--     Modena came off) is refused, and nothing is paid or recorded.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_modena_stale_amount_refused()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s jsonb;
BEGIN
  PERFORM public._seed_modena();
  PERFORM public._modena_reduce_three();
  PERFORM public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a0', 0, 164);
  PERFORM public._modena_prepare();
  s := public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111', public._modena_order_ids(),
    NULL, 120500, 'TXN-MODENA-2', 'MO-MODENA-2', 'card', 'MO-MODENA-2', NULL,
    'paycloud_webhook_fallback_finatic_verified', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.39');
  PERFORM public._expect('modena_stale/refused_amount_mismatch',
    NOT (s->>'ok')::boolean AND s->>'reason' = 'amount_mismatch'
      AND (s->>'expected_cents')::integer = 96500,
    s::text);
  PERFORM public._expect('modena_stale/nothing_paid',
    (SELECT count(*) FROM public.orders WHERE payment_status = 'paid') = 0
      AND (SELECT count(*) FROM public.payment_events) = 0,
    NULL);
END;
$$;

-- ==================================================================================================
-- M4. B: Modena was COOKED first. The void is refused (window_closed) and NOTHING about Modena or
--     the money moves: live stays N$1,205, and that is what a settlement then takes.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_modena_refused()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  s jsonb;
BEGIN
  PERFORM public._seed_modena();
  PERFORM public._modena_reduce_three();
  UPDATE public.order_lines SET kitchen_state = 'cooked'
   WHERE id = 'eeeeeeee-0000-4000-8000-0000000001a0';
  r := public._modena_amend('eeeeeeee-0000-4000-8000-0000000001a0', 0, 164);

  PERFORM public._expect('modena_refused/window_closed',
    jsonb_array_length(r->'applied') = 0 AND r->>'order_id' IS NULL
      AND r->'refused' = '[{"line_id":"eeeeeeee-0000-4000-8000-0000000001a0","reason":"window_closed"}]'::jsonb,
    r::text);
  PERFORM public._expect('modena_refused/line_still_cooked',
    (SELECT kitchen_state FROM public.order_lines WHERE id = 'eeeeeeee-0000-4000-8000-0000000001a0') = 'cooked',
    NULL);
  PERFORM public._expect('modena_refused/no_void_event',
    (SELECT count(*) FROM public.order_line_events
      WHERE order_line_id = 'eeeeeeee-0000-4000-8000-0000000001a0') = 0, NULL);
  PERFORM public._expect('modena_refused/live_still_1205', public._modena_tab_live_cents() = 120500,
    public._modena_tab_live_cents()::text);
  PERFORM public._expect('modena_refused/no_order_created', (SELECT count(*) FROM public.orders) = 4, NULL);

  PERFORM public._expect('modena_refused/prepare_writes_1205', public._modena_prepare() = 120500, NULL);
  s := public._modena_settle(120500);
  PERFORM public._expect('modena_refused/settles_1205', (s->>'ok')::boolean, s::text);
  PERFORM public._expect('modena_refused/ledger_1205',
    (SELECT amount FROM public.payment_events WHERE event_type = 'sale') = 1205, NULL);
END;
$$;

-- ==================================================================================================
-- THE SNAPSHOT the jest chain replays. Every row the RPCs wrote, after every step, both branches.
-- Timestamps are left out (they are now()); generated ids are normalised by the runner.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._modena_state()
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'tabs', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', id, 'restaurant_id', restaurant_id, 'table_number', table_number,
               'status', status, 'total', total)), '[]'::jsonb)
               FROM public.tabs WHERE id = '22222222-2222-4222-8222-222222222222'),
    'orders', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', id, 'restaurant_id', restaurant_id, 'firebase_restaurant_id', firebase_restaurant_id,
               'tab_id', tab_id, 'table_number', table_number, 'order_number', order_number,
               'status', status, 'payment_status', payment_status, 'payment_method', payment_method,
               'payment_reference', payment_reference,
               'paycloud_merchant_order_no', paycloud_merchant_order_no,
               'paycloud_transaction_id', paycloud_transaction_id, 'channel', channel,
               'subtotal', subtotal, 'tax', tax, 'total', total, 'items', items,
               'pending_charge_cents', pending_charge_cents,
               'pending_settlement_id', pending_settlement_id,
               'settled_charge_cents', settled_charge_cents) ORDER BY order_number), '[]'::jsonb)
               FROM public.orders WHERE tab_id = '22222222-2222-4222-8222-222222222222'),
    'order_lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', l.id, 'restaurant_id', l.restaurant_id, 'order_id', l.order_id, 'tab_id', l.tab_id,
               'source_item_index', l.source_item_index, 'name_snapshot', l.name_snapshot,
               'quantity', l.quantity, 'line_note', l.line_note, 'route_to', l.route_to,
               'kitchen_state', l.kitchen_state, 'bar_state', l.bar_state)
               ORDER BY o.order_number, l.source_item_index), '[]'::jsonb)
               FROM public.order_lines l JOIN public.orders o ON o.id = l.order_id
              WHERE o.tab_id = '22222222-2222-4222-8222-222222222222'),
    'order_line_events', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', e.id, 'restaurant_id', e.restaurant_id, 'order_line_id', e.order_line_id,
               'station', e.station, 'from_state', e.from_state, 'to_state', e.to_state,
               'actor_kind', e.actor_kind, 'actor_user_id', e.actor_user_id, 'void_reason', e.void_reason)
               ORDER BY o.order_number, l.source_item_index, e.station, e.to_state), '[]'::jsonb)
               FROM public.order_line_events e
               JOIN public.order_lines l ON l.id = e.order_line_id
               JOIN public.orders o ON o.id = l.order_id
              WHERE o.tab_id = '22222222-2222-4222-8222-222222222222'),
    'payment_tips', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'restaurant_id', restaurant_id, 'tip_cents', tip_cents, 'method', method,
               'staff_user_id', staff_user_id, 'payment_reference', payment_reference)
               ORDER BY payment_reference), '[]'::jsonb)
               FROM public.payment_tips),
    'payment_events', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', id, 'restaurant_id', restaurant_id, 'event_type', event_type, 'amount', amount,
               'order_ids', to_jsonb(order_ids), 'transaction_id', transaction_id,
               'business_order_no', business_order_no, 'reason_code', reason_code)
               ORDER BY business_order_no), '[]'::jsonb)
               FROM public.payment_events)
  );
$$;

CREATE OR REPLACE FUNCTION public._modena_step(p_name text, p_line uuid, p_quantity integer, p_order_number integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
BEGIN
  r := public._modena_amend(p_line, p_quantity, p_order_number);
  RETURN jsonb_build_object(
    'name', p_name, 'kind', 'amend_order_lines',
    'call', jsonb_build_object(
      'p_restaurant_id', '11111111-1111-4111-8111-111111111111',
      'p_tab_id', '22222222-2222-4222-8222-222222222222',
      'p_order_number', p_order_number, 'p_actor_kind', 'terminal',
      'p_actor_user_id', '55555555-5555-4555-8555-555555555555',
      'p_amendments', jsonb_build_array(jsonb_build_object('line_id', p_line, 'new_quantity', p_quantity))),
    'result', r,
    'post', public._modena_state());
END;
$$;

-- THE N$220 + N$500 = N$720 SETTLEMENT (Riviera #154/#155), with and without a N$30 gratuity,
-- through the real settle_order_payment -- for the invoice suite, which must reconcile an invoice
-- against the ledger row this function writes. Items in the stored shape, on tab T.
CREATE OR REPLACE FUNCTION public._seed_720(p_tip_cents integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._seed();
  UPDATE public.tabs SET table_number = 1, status = 'open', total = 720
   WHERE id = '22222222-2222-4222-8222-222222222222';
  INSERT INTO public.orders
    (id, restaurant_id, firebase_restaurant_id, tab_id, table_number, order_number, status,
     payment_status, payment_method, channel, subtotal, tax, total, items, placed_at,
     pending_charge_cents, pending_tip_cents, pending_tip_staff_user_id, pending_settlement_id)
  VALUES
    ('eeeeeeee-0000-4000-8000-000000000154', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 154,
     'pending', 'pending', 'cash', 'pos', 191.30, 28.70, 220,
     '[{"menuItemId":"dddddddd-0000-4000-8000-0000000001d3","name":"Double Cheese Burger","quantity":2,"unitPrice":90,"subtotal":156.52,"tax":23.48,"total":180,"taxRateId":"abab0001-0000-4000-8000-000000000015"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d6","name":"Soft Drinks","quantity":1,"unitPrice":40,"subtotal":34.78,"tax":5.22,"total":40,"taxRateId":"abab0001-0000-4000-8000-000000000015"}]'::jsonb,
     '2026-09-24T19:00:00Z', 22000, 0, NULL, '77777777-7777-4777-8777-777777777777'),
    ('eeeeeeee-0000-4000-8000-000000000155', '11111111-1111-4111-8111-111111111111',
     '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 155,
     'pending', 'pending', 'cash', 'pos', 434.78, 65.22, 500,
     '[{"menuItemId":"dddddddd-0000-4000-8000-0000000001d2","name":"Seared Salmon","quantity":1,"unitPrice":460,"subtotal":400.00,"tax":60.00,"total":460,"taxRateId":"abab0001-0000-4000-8000-000000000015"},
       {"menuItemId":"dddddddd-0000-4000-8000-0000000001d7","name":"Mixers","quantity":1,"unitPrice":40,"subtotal":34.78,"tax":5.22,"total":40,"taxRateId":"abab0001-0000-4000-8000-000000000015"}]'::jsonb,
     '2026-09-24T19:05:00Z', 50000 + p_tip_cents, p_tip_cents,
     CASE WHEN p_tip_cents > 0 THEN '55555555-5555-4555-8555-555555555555'::uuid END,
     '77777777-7777-4777-8777-777777777777');
END;
$$;

CREATE OR REPLACE FUNCTION public._settle_720(p_tip_cents integer)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.settle_order_payment(
    '11111111-1111-4111-8111-111111111111',
    ARRAY['eeeeeeee-0000-4000-8000-000000000154', 'eeeeeeee-0000-4000-8000-000000000155']::uuid[],
    72000 + p_tip_cents, 72000 + p_tip_cents, 'TXN-RIV-720', 'MO-RIV-720', 'card', 'MO-RIV-720', NULL,
    'terminal_verify_payment', 'term-1', p_tip_cents,
    CASE WHEN p_tip_cents > 0 THEN '55555555-5555-4555-8555-555555555555'::uuid END,
    ARRAY[]::uuid[], '2.39');
$$;

-- ==================================================================================================
-- M5. 720 with a N$30 gratuity: the ledger row is what the card was charged (N$750); each order
--     records only its own food (22000 / 50000); the tip is its own row. The invoice suite
--     reconciles against exactly this.
-- ==================================================================================================
CREATE OR REPLACE FUNCTION public._t_720_tip_split()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s jsonb;
BEGIN
  PERFORM public._seed_720(3000);
  s := public._settle_720(3000);
  PERFORM public._expect('tip720/settled', (s->>'ok')::boolean, s::text);
  PERFORM public._expect('tip720/ledger_is_the_charge',
    (SELECT amount FROM public.payment_events WHERE event_type = 'sale') = 750, NULL);
  PERFORM public._expect('tip720/orders_record_food_only',
    (SELECT array_agg(settled_charge_cents ORDER BY order_number) FROM public.orders) = ARRAY[22000, 50000],
    (SELECT array_agg(settled_charge_cents ORDER BY order_number) FROM public.orders)::text);
  PERFORM public._expect('tip720/tip_row',
    (SELECT count(*) FROM public.payment_tips WHERE tip_cents = 3000) = 1, NULL);
  PERFORM public._expect('tip720/ledger_minus_tip_is_settled_food',
    (SELECT round(amount * 100)::integer FROM public.payment_events WHERE event_type = 'sale')
      - (SELECT sum(tip_cents) FROM public.payment_tips)
      = (SELECT sum(settled_charge_cents) FROM public.orders), NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public._modena_snapshot()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  seed jsonb;
  reductions jsonb := '[]'::jsonb;
  branch_a jsonb := '[]'::jsonb;
  branch_b jsonb := '[]'::jsonb;
  riviera_720 jsonb;
  riviera_720_tip jsonb;
  s jsonb;
BEGIN
  PERFORM public._seed_modena();
  seed := public._modena_state();
  reductions := reductions
    || jsonb_build_array(public._modena_step('reduce_wywh_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a1', 1, 161))
    || jsonb_build_array(public._modena_step('reduce_burger_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a3', 1, 162))
    || jsonb_build_array(public._modena_step('reduce_salmon_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a2', 1, 163));

  -- A: the void applies, then the card settlement at the live figure.
  branch_a := branch_a
    || jsonb_build_array(public._modena_step('void_modena', 'eeeeeeee-0000-4000-8000-0000000001a0', 0, 164));
  PERFORM public._modena_prepare();
  branch_a := branch_a || jsonb_build_array(jsonb_build_object(
    'name', 'prepare_payment', 'kind', 'prepare_payment', 'post', public._modena_state()));
  s := public._modena_settle(96500);
  branch_a := branch_a || jsonb_build_array(jsonb_build_object(
    'name', 'card_settlement_965', 'kind', 'settle_order_payment',
    'call', jsonb_build_object('p_gateway_amount_cents', 96500, 'p_expected_amount_cents', 96500,
                               'p_payment_method', 'card', 'p_merchant_order_no', 'MO-MODENA-1'),
    'result', s, 'post', public._modena_state()));

  -- B: the same three reductions from a fresh seed (recorded again: the replacement orders get new
  -- ids), then the kitchen cooks Modena first and the void is refused.
  PERFORM public._seed_modena();
  branch_b := branch_b
    || jsonb_build_array(public._modena_step('reduce_wywh_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a1', 1, 161))
    || jsonb_build_array(public._modena_step('reduce_burger_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a3', 1, 162))
    || jsonb_build_array(public._modena_step('reduce_salmon_2_to_1', 'eeeeeeee-0000-4000-8000-0000000001a2', 1, 163));
  UPDATE public.order_lines SET kitchen_state = 'cooked'
   WHERE id = 'eeeeeeee-0000-4000-8000-0000000001a0';
  branch_b := branch_b || jsonb_build_array(jsonb_build_object(
    'name', 'kitchen_cooks_modena', 'kind', 'station', 'line_id', 'eeeeeeee-0000-4000-8000-0000000001a0',
    'station', 'kitchen', 'to_state', 'cooked', 'post', public._modena_state()));
  branch_b := branch_b
    || jsonb_build_array(public._modena_step('void_modena_refused', 'eeeeeeee-0000-4000-8000-0000000001a0', 0, 164));

  -- The 720 settlement, plain and tipped.
  PERFORM public._seed_720(0);
  s := public._settle_720(0);
  riviera_720 := jsonb_build_object('result', s, 'post', public._modena_state());
  PERFORM public._seed_720(3000);
  s := public._settle_720(3000);
  riviera_720_tip := jsonb_build_object('result', s, 'post', public._modena_state());

  RETURN jsonb_build_object('seed', seed, 'reductions', reductions, 'branch_a', branch_a, 'branch_b', branch_b,
                            'riviera_720', riviera_720, 'riviera_720_tip', riviera_720_tip);
END;
$$;

DO $$
DECLARE
  t text;
  tests text[] := ARRAY[
    '_t_modena_reductions',
    '_t_modena_void_applied',
    '_t_modena_stale_amount_refused',
    '_t_modena_refused',
    '_t_720_tip_split'
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
