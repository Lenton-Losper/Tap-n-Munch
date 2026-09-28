-- @env: both
--
-- amend_order_lines REFUSES TO VOID OR REDUCE A LINE WHILE ITS ORDER IS BEING CHARGED
-- (Sprint 2026-09-29 brief, task 5).
--
-- A card charge is prepared (pending_charge_cents written, stamped with pending_charge_at and the
-- order's charge basis by 20260929120000) and the reader is launched for that figure. A void landing
-- now lowers the order's live value while the card is still asked for the old, higher one. The
-- settlement would then agree with the gateway -- both read the prepared figure -- and pay the order
-- at more than it is worth.
--
-- New per-line refusal reason 'payment_in_flight', within 5 minutes of the charge being prepared
-- (the same window the guest-edit guard uses). Older than that the device is assumed to have
-- abandoned the charge and the void is allowed; if the charge nevertheless lands later,
-- settle_order_payment's block 6d (20260929120100) sees the changed basis and holds it for review.
--
-- CONTRACT C3: the refusal list gains 'payment_in_flight'. Additive -- the terminal treats any line
-- not in `applied` as not cancelled and re-fetches, which is exactly right here.
--
-- Nothing else changes: the body is 20260928150000's verbatim with two variables, two columns added
-- to the existing paid-check SELECT, and the refusal block after it. Same signature, owner and
-- grants. SAFE TO APPLY: redefines one function in place; no schema change. Requires 20260929120000
-- (pending_charge_at).

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
    v_payment_status text;
    v_pending_charge integer;
    v_pending_charge_at timestamptz;
BEGIN
    IF p_amendments IS NULL OR jsonb_typeof(p_amendments) <> 'array' OR jsonb_array_length(p_amendments) = 0 THEN
        RAISE EXCEPTION 'at least one amendment is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.tabs WHERE id = p_tab_id AND restaurant_id = p_restaurant_id
    ) THEN
        RAISE EXCEPTION 'tab % does not belong to restaurant %', p_tab_id, p_restaurant_id;
    END IF;

    -- Sprint 2026-09-28: take the TAB first (FOR KEY SHARE, the lock the replacement order's
    -- foreign key would take anyway), then the ORDERS the requested lines belong to, FOR SHARE, in
    -- id order -- the same tab-then-orders order settle_order_payment locks in, so a settlement in
    -- flight is waited for rather than raced or deadlocked. See this migration's header.
    PERFORM 1 FROM public.tabs WHERE id = p_tab_id FOR KEY SHARE;

    PERFORM 1
    FROM public.orders o
    WHERE o.id IN (
        SELECT ol.order_id
        FROM public.order_lines ol
        WHERE ol.id IN (SELECT (a->>'line_id')::uuid FROM jsonb_array_elements(p_amendments) a)
          AND ol.restaurant_id = p_restaurant_id
          AND ol.tab_id = p_tab_id
    )
    ORDER BY o.id
    FOR SHARE;

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

        -- Sprint 2026-09-28: A PAID LINE IS NOT VOIDED. Checked before the void, so a refusal writes
        -- nothing. A line that does not exist on this tab reads no row here and falls through to
        -- the UPDATE below, which reports it not_found exactly as before.
        SELECT o.payment_status, o.pending_charge_cents, o.pending_charge_at
          INTO v_payment_status, v_pending_charge, v_pending_charge_at
        FROM public.order_lines ol
        JOIN public.orders o ON o.id = ol.order_id
        WHERE ol.id = v_line_id AND ol.restaurant_id = p_restaurant_id AND ol.tab_id = p_tab_id;

        IF FOUND AND lower(btrim(COALESCE(v_payment_status, ''))) = 'paid' THEN
            v_refused := v_refused || jsonb_build_object('line_id', v_line_id, 'reason', 'order_paid');
            CONTINUE;
        END IF;

        -- Sprint 2026-09-29 (20260929120200): A LINE IS NOT VOIDED WHILE ITS ORDER IS BEING CHARGED.
        -- prepare-payment has stamped what the reader is asking for; voiding now would leave the
        -- card charging MORE than the order is worth. Same 5-minute window as the guest-edit guard
        -- (orders_refuse_edit_during_charge). Read under the FOR SHARE taken above, so a
        -- preparation that committed first is seen, and one that comes after waits for this
        -- transaction and then finds the basis moved (FTCHG) or settles into a hold (6d).
        IF FOUND AND v_pending_charge IS NOT NULL
           AND (v_pending_charge_at IS NULL OR v_pending_charge_at > now() - interval '5 minutes') THEN
            v_refused := v_refused || jsonb_build_object('line_id', v_line_id, 'reason', 'payment_in_flight');
            CONTINUE;
        END IF;

        PERFORM 1 FROM public.order_line_allocations
        WHERE order_line_id = v_line_id AND voided_at IS NULL
        FOR SHARE;

        IF EXISTS (
            SELECT 1 FROM public.order_line_allocations ola
            WHERE ola.order_line_id = v_line_id
              AND ola.voided_at IS NULL
              AND (
                  ola.settled_at IS NOT NULL
                  OR EXISTS (
                      SELECT 1 FROM public.order_line_allocation_settlements s
                      WHERE s.order_line_allocation_id = ola.id
                  )
              )
        ) THEN
            v_refused := v_refused || jsonb_build_object('line_id', v_line_id, 'reason', 'line_settled');
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

        -- Sprint 2026-09-28: the voided line's UNSETTLED allocations are voided with it, in this
        -- transaction. Left live, prepare-split-payment (which checks only allocation.voided_at)
        -- would charge a customer for the voided line and settlement would then refuse it
        -- (line_voided) -- a charge with nothing recorded. SETTLED allocations cannot be here:
        -- the line_settled refusal above returned before the void. Not re-targeted onto a
        -- replacement line (20260829170000's ruling); the replacement is allocated afresh.
        UPDATE public.order_line_allocations
        SET voided_at = now(),
            void_reason = 'line_voided_by_amendment'
        WHERE order_line_id = v_voided.id
          AND voided_at IS NULL
          AND settled_at IS NULL;

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
