-- ================================================================================================
-- Sprint 2026-09-30, RC-ORDERS. Reuses settlement-rpc.test.sql's _expect() and amend-rpc.test.sql's
-- _seed_amend() fixture (order 160 pending, 161 PAID, 162 pending; lines cccc...001-006).
--
--   20260930100000  one fulfilment line per ordered item (a double-tapped Send wrote a round twice)
--   20260930100100  settle_order_line_allocations refuses a share whose order is paid or cancelled
--
-- Every refusal has a positive control on the same fixture, so "refused" cannot pass for a
-- function that refuses everything.
-- ================================================================================================
DO $$
DECLARE
  v_dup boolean := false;
BEGIN
  PERFORM public._seed_amend();
  BEGIN
    INSERT INTO public.order_lines
      (restaurant_id, order_id, tab_id, source_item_index, name_snapshot, quantity, route_to, kitchen_state)
    VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000160',
            '22222222-2222-4222-8222-222222222222', 0, 'Modena Pasta', 2, 'kitchen', 'outstanding');
  EXCEPTION WHEN unique_violation THEN
    v_dup := true;
  END;
  PERFORM public._expect('rc_orders/second_line_for_one_item_refused', v_dup,
    'a second order_lines row for (order 160, item 0) was accepted');
  -- Positive control: the next item index on the same order is accepted.
  INSERT INTO public.order_lines
    (restaurant_id, order_id, tab_id, source_item_index, name_snapshot, quantity, route_to, kitchen_state)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000160',
          '22222222-2222-4222-8222-222222222222', 3, 'Espresso', 1, 'kitchen', 'outstanding');
  PERFORM public._expect('rc_orders/new_item_index_accepted',
    (SELECT count(*) FROM public.order_lines WHERE order_id = 'bbbbbbbb-0000-4000-8000-000000000160') = 4);
END
$$;

DO $$
DECLARE
  r jsonb;
BEGIN
  PERFORM public._seed_amend();
  -- A share on the salad of order 161, which is already PAID whole.
  INSERT INTO public.order_line_allocations
    (id, restaurant_id, order_id, order_line_id, tab_id, allocated_to, quantity_allocated, amount_cents, created_by_actor_kind)
  VALUES ('dddddddd-0000-4000-8000-0000000000a1', '11111111-1111-4111-8111-111111111111',
          'bbbbbbbb-0000-4000-8000-000000000161', 'cccccccc-0000-4000-8000-000000000004',
          '22222222-2222-4222-8222-222222222222', 'guest-9', 1, 5000, 'terminal');
  r := public.settle_order_line_allocations('11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222', ARRAY['dddddddd-0000-4000-8000-0000000000a1']::uuid[],
         'cash', 'rc-paid', '55555555-5555-4555-8555-555555555555');
  PERFORM public._expect('rc_orders/share_on_paid_order_refused',
    r->'refused'->0->>'reason' = 'order_paid', r::text);
  PERFORM public._expect('rc_orders/share_on_paid_order_no_ledger_row',
    NOT EXISTS (SELECT 1 FROM public.order_line_allocation_settlements
                 WHERE order_line_allocation_id = 'dddddddd-0000-4000-8000-0000000000a1'));

  -- Order 162 cancelled; its soup carries the fixture's unsettled share dddd...006.
  UPDATE public.orders SET status = 'cancelled', payment_status = 'cancelled'
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000162';
  r := public.settle_order_line_allocations('11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222', ARRAY['dddddddd-0000-4000-8000-000000000006']::uuid[],
         'cash', 'rc-cancelled', '55555555-5555-4555-8555-555555555555');
  PERFORM public._expect('rc_orders/share_on_cancelled_order_refused',
    r->'refused'->0->>'reason' = 'order_cancelled', r::text);
  PERFORM public._expect('rc_orders/share_on_cancelled_order_unclaimed',
    (SELECT settled_at IS NULL FROM public.order_line_allocations WHERE id = 'dddddddd-0000-4000-8000-000000000006'));

  -- Positive control: a share on the PENDING order 160 settles.
  INSERT INTO public.order_line_allocations
    (id, restaurant_id, order_id, order_line_id, tab_id, allocated_to, quantity_allocated, amount_cents, created_by_actor_kind)
  VALUES ('dddddddd-0000-4000-8000-0000000000a2', '11111111-1111-4111-8111-111111111111',
          'bbbbbbbb-0000-4000-8000-000000000160', 'cccccccc-0000-4000-8000-000000000001',
          '22222222-2222-4222-8222-222222222222', 'guest-9', 2, 24000, 'terminal');
  r := public.settle_order_line_allocations('11111111-1111-4111-8111-111111111111',
         '22222222-2222-4222-8222-222222222222', ARRAY['dddddddd-0000-4000-8000-0000000000a2']::uuid[],
         'cash', 'rc-pending', '55555555-5555-4555-8555-555555555555');
  PERFORM public._expect('rc_orders/share_on_pending_order_settles',
    jsonb_array_length(r->'applied') = 1 AND (r->'applied'->0->>'amount_cents')::int = 24000, r::text);
END
$$;
