-- amend_order_lines: void-and-replace, one transaction, per-line refusal.
--
-- ============================================================================================
-- WHY THIS IS A FUNCTION AND NOT A SEQUENCE OF PostgREST CALLS
-- ============================================================================================
--
-- Ruled: "ONE CALL, not two. A quantity change is void-plus-add and must not half-apply: a
-- voided line with no replacement is food the customer ordered and nobody is making." Every
-- write path in this codebase that needs real atomicity already does this the same way
-- (create_transfer, dispatch_transfer) -- PostgREST gives no multi-statement transaction, so
-- the only way to make void-then-add indivisible is to make it ONE statement's worth of work
-- from PostgREST's perspective: an RPC call, which Postgres runs as one transaction.
--
-- ============================================================================================
-- THE RACE, AND WHY THIS FUNCTION DOES NOT NEED AN EXPLICIT LOCK TO WIN IT CORRECTLY
-- ============================================================================================
--
-- "Prove the race: a waiter amends at the same moment the kitchen taps cooked. The kitchen
-- wins and the amendment refuses." The void write below is a single conditional UPDATE --
-- `WHERE kitchen_state = 'outstanding'` -- exactly the same optimistic-concurrency shape
-- POST /api/station/order-lines/[lineId]/state already uses for its own bump, and
-- cancelOrderWithTrail/cancelByIds already use for cancellation. Whichever writer's UPDATE
-- commits first wins by Postgres MVCC; the other's WHERE clause matches zero rows and it sees
-- that plainly. No SELECT ... FOR UPDATE is needed, and adding one would only make this
-- function block instead of losing cleanly -- worse for a waiter waiting on a response.
--
-- ============================================================================================
-- WHY QUANTITY IS SCALED, NOT RE-PRICED FROM THE MENU
-- ============================================================================================
--
-- This function never touches menu_items. The replacement item is the ORIGINAL priced item
-- (orders.items->source_item_index, already correctly priced and taxed when the round was
-- sent) with quantity, subtotal, tax and total scaled by new_quantity / old_quantity. This is
-- exact by construction and carries no re-pricing risk -- it cannot disagree with what the
-- customer was already shown, because it is a scaled copy of that same figure, not a fresh
-- catalog lookup that could have moved since. NOT RULED, AND STATED PLAINLY: per-unit
-- modifiers or surcharges that do not scale linearly with quantity are not handled specially --
-- proportional scaling is the safer default absent a ruling on that shape, not a claim that
-- every menu item's pricing is actually linear.
--
-- ============================================================================================
-- new_quantity = 0 IS A PURE VOID, NO REPLACEMENT LINE
-- ============================================================================================
--
-- Nothing is being asked of the kitchen or bar for a quantity of zero, so nothing is added to
-- the replacement order for it. It is still reported in `applied`, action 'voided'.
--
-- ============================================================================================
-- ORDER NUMBER: PASSED IN, RETRIED BY THE CALLER, NOT ALLOCATED HERE
-- ============================================================================================
--
-- lib/orders/order-number.ts's own docblock rules out an advisory lock or a sequence for this
-- exact reason: PostgREST does not pin a session, so a lock taken outside this function's own
-- transaction protects nothing, and a lock taken INSIDE it would only serialise amendments
-- against each other, not against the ordinary round-sending path this same unique index
-- guards. So allocation stays where it already lives: the caller reads max(order_number)+1 via
-- the existing nextOrderNumber() helper and passes it in. If orders_firebase_restaurant_id_
-- order_number_key rejects it, THIS ENTIRE FUNCTION raises and the whole transaction rolls
-- back -- nothing voided, nothing inserted -- and the caller retries the WHOLE call with a
-- freshly read number, the same bounded retry insertWithOrderNumber() already uses elsewhere.
--
-- ============================================================================================
-- WHAT THIS FUNCTION DOES NOT DO
-- ============================================================================================
--
-- No stock check, no idempotency key, no payment. The replacement order is a 'pending' /
-- 'pos' / 'cash' order on the same tab, matching what a waiter-led round already looks like
-- (see POST /api/terminal/rounds) -- it is settled later with the rest of the tab, same as any
-- other round. Permission checks (orders:update, the per-line window) happen in the TypeScript
-- caller before this is invoked, and this function trusts its caller -- same convention as
-- create_transfer.

CREATE OR REPLACE FUNCTION "public"."amend_order_lines"(
    p_restaurant_id uuid,
    p_tab_id uuid,
    p_order_number integer,
    p_actor_kind text,
    p_actor_user_id uuid,
    p_amendments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_amendment jsonb;
    v_line_id uuid;
    v_new_quantity numeric;
    v_voided record;
    v_source_item jsonb;
    v_old_quantity numeric;
    v_ratio numeric;
    v_new_item jsonb;
    v_new_items jsonb := '[]'::jsonb;
    v_new_lines jsonb := '[]'::jsonb;
    v_applied jsonb := '[]'::jsonb;
    v_refused jsonb := '[]'::jsonb;
    v_new_order_id uuid;
    v_new_line_id uuid;
    v_new_subtotal numeric := 0;
    v_new_tax numeric := 0;
    v_new_total numeric := 0;
    v_next_source_index integer := 0;
BEGIN
    IF p_amendments IS NULL OR jsonb_typeof(p_amendments) <> 'array' OR jsonb_array_length(p_amendments) = 0 THEN
        RAISE EXCEPTION 'at least one amendment is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.tabs WHERE id = p_tab_id AND restaurant_id = p_restaurant_id
    ) THEN
        RAISE EXCEPTION 'tab % does not belong to restaurant %', p_tab_id, p_restaurant_id;
    END IF;

    FOR v_amendment IN SELECT * FROM jsonb_array_elements(p_amendments)
    LOOP
        v_line_id := (v_amendment->>'line_id')::uuid;
        v_new_quantity := (v_amendment->>'new_quantity')::numeric;

        IF v_new_quantity IS NULL OR v_new_quantity < 0 THEN
            v_refused := v_refused || jsonb_build_object(
                'line_id', v_line_id, 'reason', 'invalid_quantity'
            );
            CONTINUE;
        END IF;

        -- THE VOID, AND THE WHOLE RACE-SAFETY OF THIS FUNCTION. Only a station-half that is
        -- still 'outstanding' moves to 'voided'; a half already NULL (not owned) stays NULL.
        -- The WHERE clause requires EVERY owned half to still be 'outstanding' -- a round that
        -- is half-cooked (kitchen done, bar not) must refuse, per the ruling that a round can
        -- be half-cooked and amendment is decided per line, not per round.
        UPDATE public.order_lines
        SET kitchen_state = CASE WHEN kitchen_state = 'outstanding' THEN 'voided' ELSE kitchen_state END,
            bar_state = CASE WHEN bar_state = 'outstanding' THEN 'voided' ELSE bar_state END
        WHERE id = v_line_id
          AND restaurant_id = p_restaurant_id
          AND tab_id = p_tab_id
          AND (kitchen_state IS NULL OR kitchen_state = 'outstanding')
          AND (bar_state IS NULL OR bar_state = 'outstanding')
          AND (kitchen_state IS NOT NULL OR bar_state IS NOT NULL)
        RETURNING id, order_id, source_item_index, route_to, name_snapshot, line_note,
                  quantity
        INTO v_voided;

        IF v_voided.id IS NULL THEN
            -- Distinguish "does not exist / wrong tab" from "window closed" so the P5 can say
            -- which. A second read costs nothing here -- this line is not going to be amended
            -- either way.
            IF EXISTS (
                SELECT 1 FROM public.order_lines
                WHERE id = v_line_id AND restaurant_id = p_restaurant_id AND tab_id = p_tab_id
            ) THEN
                v_refused := v_refused || jsonb_build_object('line_id', v_line_id, 'reason', 'window_closed');
            ELSE
                v_refused := v_refused || jsonb_build_object('line_id', v_line_id, 'reason', 'not_found');
            END IF;
            CONTINUE;
        END IF;

        -- Void event(s), one per station this line was owned by -- matches
        -- voidOutstandingOrderLines' own shape (lib/orders/order-lines.ts), which this
        -- deliberately mirrors rather than reuses: that function reads current state itself
        -- and would re-read a row this function just changed, re-opening the same race this
        -- function exists to close in one transaction.
        IF v_voided.route_to IN ('kitchen', 'both', 'unrouted') THEN
            INSERT INTO public.order_line_events
                (restaurant_id, order_line_id, station, from_state, to_state, actor_kind, actor_user_id)
            VALUES
                (p_restaurant_id, v_voided.id, 'kitchen', 'outstanding', 'voided', p_actor_kind, p_actor_user_id);
        END IF;
        IF v_voided.route_to IN ('bar', 'both', 'unrouted') THEN
            INSERT INTO public.order_line_events
                (restaurant_id, order_line_id, station, from_state, to_state, actor_kind, actor_user_id)
            VALUES
                (p_restaurant_id, v_voided.id, 'bar', 'outstanding', 'voided', p_actor_kind, p_actor_user_id);
        END IF;

        IF v_new_quantity = 0 THEN
            v_applied := v_applied || jsonb_build_object(
                'line_id', v_voided.id, 'action', 'voided'
            );
            CONTINUE;
        END IF;

        -- THE REPLACEMENT ITEM. Scaled from the ORIGINAL priced item, never re-priced from the
        -- menu -- see the function's own header.
        SELECT items -> v_voided.source_item_index INTO v_source_item
        FROM public.orders WHERE id = v_voided.order_id;

        IF v_source_item IS NULL THEN
            RAISE EXCEPTION 'source item at index % not found on order % for line %',
                v_voided.source_item_index, v_voided.order_id, v_voided.id;
        END IF;

        v_old_quantity := COALESCE((v_source_item->>'quantity')::numeric, 0);
        IF v_old_quantity <= 0 THEN
            RAISE EXCEPTION 'line % has an invalid source quantity, cannot scale', v_voided.id;
        END IF;
        v_ratio := v_new_quantity / v_old_quantity;

        v_new_item := v_source_item
            || jsonb_build_object(
                'quantity', v_new_quantity,
                'subtotal', round(COALESCE((v_source_item->>'subtotal')::numeric, 0) * v_ratio, 2),
                'tax', round(COALESCE((v_source_item->>'tax')::numeric, 0) * v_ratio, 2),
                'total', round(COALESCE((v_source_item->>'total')::numeric, 0) * v_ratio, 2)
            );

        v_new_subtotal := v_new_subtotal + COALESCE((v_new_item->>'subtotal')::numeric, 0);
        v_new_tax := v_new_tax + COALESCE((v_new_item->>'tax')::numeric, 0);
        v_new_total := v_new_total + COALESCE((v_new_item->>'total')::numeric, 0);

        v_new_items := v_new_items || v_new_item;
        v_new_lines := v_new_lines || jsonb_build_object(
            'old_line_id', v_voided.id,
            'source_item_index', v_next_source_index,
            'name_snapshot', v_voided.name_snapshot,
            'quantity', v_new_quantity,
            'line_note', v_voided.line_note,
            'route_to', v_voided.route_to
        );
        v_next_source_index := v_next_source_index + 1;
    END LOOP;

    -- Nothing survived the window -- every requested line was refused. No order to create.
    IF jsonb_array_length(v_new_items) = 0 THEN
        RETURN jsonb_build_object(
            'order_id', NULL, 'order_number', NULL, 'applied', v_applied, 'refused', v_refused
        );
    END IF;

    INSERT INTO public.orders (
        restaurant_id, firebase_restaurant_id, tab_id, table_id, table_number, order_number,
        status, payment_status, payment_method, channel, items, subtotal, tax, total,
        is_closed, placed_at
    )
    SELECT
        p_restaurant_id, p_restaurant_id::text, p_tab_id, t.table_id, t.table_number, p_order_number,
        'pending', 'pending', 'cash', 'pos', v_new_items, v_new_subtotal, v_new_tax, v_new_total,
        false, now()
    FROM public.tabs t WHERE t.id = p_tab_id
    RETURNING id INTO v_new_order_id;

    -- One order_lines row per replacement, in the same order as v_new_items so
    -- source_item_index lines up -- same requirement writeOrderLines' own caller (rounds/
    -- route.ts) already has to satisfy, for the same reason.
    FOR v_amendment IN SELECT * FROM jsonb_array_elements(v_new_lines)
    LOOP
        INSERT INTO public.order_lines (
            restaurant_id, order_id, tab_id, source_item_index, name_snapshot, quantity,
            line_note, route_to, kitchen_state, bar_state
        )
        VALUES (
            p_restaurant_id, v_new_order_id, p_tab_id,
            (v_amendment->>'source_item_index')::integer,
            v_amendment->>'name_snapshot',
            (v_amendment->>'quantity')::numeric,
            v_amendment->>'line_note',
            v_amendment->>'route_to',
            CASE WHEN v_amendment->>'route_to' IN ('kitchen', 'both', 'unrouted') THEN 'outstanding' ELSE NULL END,
            CASE WHEN v_amendment->>'route_to' IN ('bar', 'both', 'unrouted') THEN 'outstanding' ELSE NULL END
        )
        RETURNING id INTO v_new_line_id;

        IF v_amendment->>'route_to' IN ('kitchen', 'both', 'unrouted') THEN
            INSERT INTO public.order_line_events
                (restaurant_id, order_line_id, station, from_state, to_state, actor_kind, actor_user_id)
            VALUES
                (p_restaurant_id, v_new_line_id, 'kitchen', NULL, 'outstanding', p_actor_kind, p_actor_user_id);
        END IF;
        IF v_amendment->>'route_to' IN ('bar', 'both', 'unrouted') THEN
            INSERT INTO public.order_line_events
                (restaurant_id, order_line_id, station, from_state, to_state, actor_kind, actor_user_id)
            VALUES
                (p_restaurant_id, v_new_line_id, 'bar', NULL, 'outstanding', p_actor_kind, p_actor_user_id);
        END IF;

        v_applied := v_applied || jsonb_build_object(
            'line_id', v_amendment->>'old_line_id', 'action', 'replaced', 'new_line_id', v_new_line_id
        );
    END LOOP;

    RETURN jsonb_build_object(
        'order_id', v_new_order_id,
        'order_number', p_order_number,
        'applied', v_applied,
        'refused', v_refused
    );
END;
$$;

ALTER FUNCTION "public"."amend_order_lines"(uuid, uuid, integer, text, uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."amend_order_lines"(uuid, uuid, integer, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."amend_order_lines"(uuid, uuid, integer, text, uuid, jsonb) TO service_role;
