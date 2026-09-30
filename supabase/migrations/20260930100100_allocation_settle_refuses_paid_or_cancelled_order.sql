-- @env: both
--
-- settle_order_line_allocations REFUSES A SHARE WHOSE ORDER IS PAID OR CANCELLED
-- (Sprint 2026-09-30, RC-ORDERS B8 / G).
--
-- The function refused a share whose LINE was voided, and nothing about its ORDER. Two ways that
-- took money twice or for nothing, both reproduced through the real routes (chaos scenario
-- orders-cancel-kitchen, O16/O18):
--   * a share created while the order was unpaid, then the order settled whole (cash or card):
--     settling the share took the same food's money a second time;
--   * a whole-order cancel leaves a line the pass already passed at 'ready' (recorded ruling in
--     voidOutstandingOrderLines: made food is not un-made), so line_voided did not see it, and a
--     share on it could be settled against an order nobody owes.
-- New refusal reasons 'order_paid' and 'order_cancelled'. CONTRACT: additive to the refusal list;
-- the route and terminal treat any refused allocation as not settled.
--
-- The whole-order settlement's own marking of an order paid (settle-allocations route, after this
-- RPC) happens only once every share is settled, so a multi-share order is never refused by its own
-- completion.
--
-- Nothing else changes: the body is 20260929120300's verbatim with one record variable and one
-- refusal block after the line_voided check. Same signature and owner; grants restated with the
-- explicit anon/authenticated REVOKE of 20260929150000. SAFE TO APPLY: redefines one function in
-- place; no schema change.

CREATE OR REPLACE FUNCTION public.settle_order_line_allocations(
  p_restaurant_id uuid,
  p_tab_id uuid,
  p_allocation_ids uuid[],
  p_method text,
  p_payment_reference text,
  p_staff_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_claimed record;
  v_line record;
  v_order record;
  v_applied jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
BEGIN
  IF p_allocation_ids IS NULL OR array_length(p_allocation_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'at least one allocation_id is required';
  END IF;
  IF p_method NOT IN ('cash', 'card') THEN
    RAISE EXCEPTION 'unsupported method %', p_method;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tabs WHERE id = p_tab_id AND restaurant_id = p_restaurant_id
  ) THEN
    RAISE EXCEPTION 'tab % does not belong to restaurant %', p_tab_id, p_restaurant_id;
  END IF;

  -- Sprint 2026-09-29 (20260929120300): THE TAB, THEN THE ORDERS THESE ALLOCATIONS BELONG TO, FOR
  -- UPDATE, in id order -- settle_order_payment's lock order exactly, so the two serialise and
  -- cannot deadlock. An item settlement changes what a whole-order card charge is worth (its
  -- ledger row is part of order_charge_basis()); without this lock it could commit between
  -- settle_order_payment locking the orders and block 6d reading the basis, and the card would
  -- be applied at a figure that already counted the item. Now it either lands first (6d sees it
  -- and holds) or waits for the card settlement to commit.
  PERFORM 1 FROM public.tabs WHERE id = p_tab_id FOR UPDATE;

  PERFORM 1
  FROM public.orders o
  WHERE o.id IN (
    SELECT ola.order_id
    FROM public.order_line_allocations ola
    WHERE ola.id = ANY (p_allocation_ids)
      AND ola.restaurant_id = p_restaurant_id
      AND ola.tab_id = p_tab_id
  )
  ORDER BY o.id
  FOR UPDATE;

  FOREACH v_id IN ARRAY p_allocation_ids
  LOOP
    -- Refuse up front if the underlying line was fully voided since this allocation was made.
    -- Read-then-decide is safe here (not a race with the claim below): a line voiding after
    -- this check but before the claim commits simply means the allocation is claimed for money
    -- against food that was voided a moment later, which is the SAME order-level question
    -- "is this food still owed" already is for whole-order settlement -- not a new race this
    -- function needs to close, per the header's ruling not to guess that business rule here.
    SELECT ol.kitchen_state, ol.bar_state INTO v_line
    FROM public.order_line_allocations ola
    JOIN public.order_lines ol ON ol.id = ola.order_line_id
    WHERE ola.id = v_id AND ola.restaurant_id = p_restaurant_id AND ola.tab_id = p_tab_id;

    IF NOT FOUND THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'not_found');
      CONTINUE;
    END IF;

    IF (v_line.kitchen_state IS NULL OR v_line.kitchen_state = 'voided')
       AND (v_line.bar_state IS NULL OR v_line.bar_state = 'voided')
       AND NOT (v_line.kitchen_state IS NULL AND v_line.bar_state IS NULL) THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'line_voided');
      CONTINUE;
    END IF;

    -- Sprint 2026-09-30 (20260930100100): NOT ON AN ORDER THAT IS ALREADY PAID OR CANCELLED.
    -- A share made before the whole order was settled (cash/card on the order) would otherwise take
    -- the same food's money a second time; a share on a cancelled order (a line the pass had
    -- already passed stays 'ready', so line_voided does not see it) would take money for an order
    -- nobody owes. Read under the FOR UPDATE on the orders taken above, so a settlement or cancel
    -- that committed first is seen.
    SELECT o.payment_status, o.status INTO v_order
    FROM public.order_line_allocations ola
    JOIN public.orders o ON o.id = ola.order_id
    WHERE ola.id = v_id AND ola.restaurant_id = p_restaurant_id AND ola.tab_id = p_tab_id;

    IF lower(btrim(COALESCE(v_order.payment_status, ''))) = 'paid' THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'order_paid');
      CONTINUE;
    END IF;
    IF lower(btrim(COALESCE(v_order.status, ''))) = 'cancelled'
       OR lower(btrim(COALESCE(v_order.payment_status, ''))) = 'cancelled' THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'order_cancelled');
      CONTINUE;
    END IF;

    -- THE CLAIM. Single conditional UPDATE -- only an allocation still unsettled and unvoided
    -- can be claimed, and only one concurrent caller can win it (Postgres MVCC), the same shape
    -- amend_order_lines()'s own void step and order_lines.kitchen_state bumps already use.
    UPDATE public.order_line_allocations
    SET settled_at = now()
    WHERE id = v_id
      AND restaurant_id = p_restaurant_id
      AND tab_id = p_tab_id
      AND voided_at IS NULL
      AND settled_at IS NULL
    RETURNING id, amount_cents INTO v_claimed;

    IF v_claimed.id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.order_line_allocations
        WHERE id = v_id AND voided_at IS NOT NULL
      ) THEN
        v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'voided');
      ELSE
        v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'already_settled');
      END IF;
      CONTINUE;
    END IF;

    -- The append-only ledger row -- the actual, durable record of money collected. This insert
    -- happening AFTER the claim above (not before) means the claim -- and only the claim -- is
    -- the thing two concurrent callers race on; this insert cannot itself be double-run for the
    -- same allocation because only one caller's claim UPDATE can ever return a row for it.
    INSERT INTO public.order_line_allocation_settlements
      (restaurant_id, order_line_allocation_id, tab_id, amount_cents, method, payment_reference, staff_user_id)
    VALUES
      (p_restaurant_id, v_claimed.id, p_tab_id, v_claimed.amount_cents, p_method, p_payment_reference, p_staff_user_id);

    v_applied := v_applied || jsonb_build_object(
      'allocation_id', v_claimed.id, 'amount_cents', v_claimed.amount_cents
    );
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'refused', v_refused);
END;
$$;

ALTER FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) TO service_role;
