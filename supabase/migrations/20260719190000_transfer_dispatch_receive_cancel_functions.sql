-- Workstream 3 (3/3): dispatch_transfer / receive_transfer / cancel_transfer.
--
-- Concurrency note (dispatch_transfer): stock is a pure append-only ledger (current
-- quantity = SUM(stock_movements.quantity_delta)) -- there is no mutable balance row to
-- lock, so a plain SELECT ... FOR UPDATE against existing ledger rows does not serialize a
-- future INSERT. Sufficiency is instead protected by a transaction-scoped Postgres
-- advisory lock keyed on the source stock_item_id (pg_advisory_xact_lock), acquired
-- immediately before recomputing the running balance and validating quantity_sent against
-- it, held until the transaction commits or rolls back.
--
-- Known scope limit (deliberately not addressed here): this advisory lock only serializes
-- transfer-vs-transfer dispatches against the same stock_item. It does NOT protect against
-- a dispatch racing a sale via deduct_recipe_stock, because that trigger does not take the
-- same lock -- see scripts/verify-stock-transfers-staging.ts Part 4 for a real concurrency
-- test of this gap. deduct_recipe_stock is not modified here; per the architecture it
-- requires zero changes, and if this gap turns out to be unacceptable that's a decision to
-- bring back, not to make unilaterally inside this migration.

CREATE OR REPLACE FUNCTION "public"."dispatch_transfer"(p_transfer_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer record;
    v_item record;
    v_source_stock_item_id uuid;
    v_available numeric;
BEGIN
    -- Locks the transfer row itself, serializing concurrent dispatch/receive/cancel calls
    -- against this SAME transfer (distinct from the per-stock-item advisory lock below,
    -- which serializes concurrent dispatches of DIFFERENT transfers sharing a source item).
    SELECT * INTO v_transfer
    FROM public.stock_transfers
    WHERE id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transfer % not found', p_transfer_id;
    END IF;

    IF v_transfer.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'transfer % is cancelled and cannot be dispatched', p_transfer_id;
    END IF;

    IF v_transfer.status <> 'DRAFT' THEN
        RETURN; -- already IN_TRANSIT or RECEIVED: idempotent no-op
    END IF;

    -- Preflight every item on BOTH sides before posting anything for ANY item. The
    -- destination isn't credited until receive, but its mapping must exist now so receive
    -- can never fail later on a missing-configuration error.
    FOR v_item IN
        SELECT sti.organization_stock_item_id
        FROM public.stock_transfer_items sti
        WHERE sti.transfer_id = p_transfer_id
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.stock_items
            WHERE restaurant_id = v_transfer.from_restaurant_id
              AND organization_stock_item_id = v_item.organization_stock_item_id
              AND is_active = true
        ) THEN
            RAISE EXCEPTION 'organization_stock_item % has no active stock_items mapping at source restaurant %', v_item.organization_stock_item_id, v_transfer.from_restaurant_id;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.stock_items
            WHERE restaurant_id = v_transfer.to_restaurant_id
              AND organization_stock_item_id = v_item.organization_stock_item_id
              AND is_active = true
        ) THEN
            RAISE EXCEPTION 'organization_stock_item % has no active stock_items mapping at destination restaurant %', v_item.organization_stock_item_id, v_transfer.to_restaurant_id;
        END IF;
    END LOOP;

    -- Post source-side movements. Ordered by organization_stock_item_id so two transfers
    -- dispatching overlapping items always acquire their advisory locks in the same
    -- relative order, avoiding a deadlock between them.
    FOR v_item IN
        SELECT sti.organization_stock_item_id, sti.quantity_sent
        FROM public.stock_transfer_items sti
        WHERE sti.transfer_id = p_transfer_id
        ORDER BY sti.organization_stock_item_id
    LOOP
        SELECT id INTO v_source_stock_item_id
        FROM public.stock_items
        WHERE restaurant_id = v_transfer.from_restaurant_id
          AND organization_stock_item_id = v_item.organization_stock_item_id
          AND is_active = true;

        PERFORM pg_advisory_xact_lock(hashtext(v_source_stock_item_id::text));

        SELECT COALESCE(SUM(quantity_delta), 0) INTO v_available
        FROM public.stock_movements
        WHERE stock_item_id = v_source_stock_item_id;

        IF v_available < v_item.quantity_sent THEN
            RAISE EXCEPTION 'insufficient stock for organization_stock_item % at restaurant %: available %, requested %', v_item.organization_stock_item_id, v_transfer.from_restaurant_id, v_available, v_item.quantity_sent;
        END IF;

        INSERT INTO public.stock_movements (
            restaurant_id, stock_item_id, quantity_delta, reason,
            reference_type, reference_id, created_by, created_at
        ) VALUES (
            v_transfer.from_restaurant_id, v_source_stock_item_id, -v_item.quantity_sent, 'transfer_out',
            'stock_transfer', p_transfer_id, p_user_id, now()
        );
    END LOOP;

    UPDATE public.stock_transfers
    SET status = 'IN_TRANSIT', dispatched_by = p_user_id, dispatched_at = now()
    WHERE id = p_transfer_id;
END;
$$;

ALTER FUNCTION "public"."dispatch_transfer"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."dispatch_transfer"(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."dispatch_transfer"(uuid, uuid) TO authenticated, service_role;

-- p_received_quantities: jsonb array of {stock_transfer_item_id, quantity_received,
-- variance_reason}, same jsonb-array-of-objects convention as create_restaurant_for_user's
-- p_roles. NULL, or an item simply absent from the array, means "confirm all received"
-- for that item (quantity_received defaults to quantity_sent, no variance_reason needed).
CREATE OR REPLACE FUNCTION "public"."receive_transfer"(
    p_transfer_id uuid,
    p_user_id uuid,
    p_received_quantities jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer record;
    v_item record;
    v_override jsonb;
    v_quantity_received numeric;
    v_variance_reason text;
    v_dest_stock_item_id uuid;
BEGIN
    SELECT * INTO v_transfer
    FROM public.stock_transfers
    WHERE id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transfer % not found', p_transfer_id;
    END IF;

    IF v_transfer.status = 'RECEIVED' THEN
        RETURN; -- idempotent no-op
    END IF;

    IF v_transfer.status <> 'IN_TRANSIT' THEN
        RAISE EXCEPTION 'transfer % is not IN_TRANSIT (status=%)', p_transfer_id, v_transfer.status;
    END IF;

    FOR v_item IN
        SELECT sti.id, sti.organization_stock_item_id, sti.quantity_sent
        FROM public.stock_transfer_items sti
        WHERE sti.transfer_id = p_transfer_id
        ORDER BY sti.organization_stock_item_id
    LOOP
        v_override := NULL;
        IF p_received_quantities IS NOT NULL THEN
            SELECT elem INTO v_override
            FROM jsonb_array_elements(p_received_quantities) elem
            WHERE (elem->>'stock_transfer_item_id')::uuid = v_item.id;
        END IF;

        IF v_override IS NULL THEN
            v_quantity_received := v_item.quantity_sent;
            v_variance_reason := NULL;
        ELSE
            v_quantity_received := (v_override->>'quantity_received')::numeric;
            v_variance_reason := NULLIF(btrim(v_override->>'variance_reason'), '');

            IF v_quantity_received IS DISTINCT FROM v_item.quantity_sent AND v_variance_reason IS NULL THEN
                RAISE EXCEPTION 'variance_reason is required for transfer_item % (sent %, received %)', v_item.id, v_item.quantity_sent, v_quantity_received;
            END IF;
        END IF;

        IF v_quantity_received IS NULL OR v_quantity_received < 0 THEN
            RAISE EXCEPTION 'quantity_received for transfer_item % must be zero or greater', v_item.id;
        END IF;

        -- Already confirmed to exist at dispatch time (the preflight in dispatch_transfer
        -- checked both sides) -- a miss here means a defect (e.g. the mapping was
        -- deactivated mid-transit), not a normal failure path.
        SELECT id INTO v_dest_stock_item_id
        FROM public.stock_items
        WHERE restaurant_id = v_transfer.to_restaurant_id
          AND organization_stock_item_id = v_item.organization_stock_item_id
          AND is_active = true;

        IF v_dest_stock_item_id IS NULL THEN
            RAISE EXCEPTION 'defect: destination stock_items mapping for organization_stock_item % missing at receive time (restaurant %) -- was confirmed to exist at dispatch', v_item.organization_stock_item_id, v_transfer.to_restaurant_id;
        END IF;

        UPDATE public.stock_transfer_items
        SET quantity_received = v_quantity_received, variance_reason = v_variance_reason
        WHERE id = v_item.id;

        INSERT INTO public.stock_movements (
            restaurant_id, stock_item_id, quantity_delta, reason,
            reference_type, reference_id, created_by, created_at
        ) VALUES (
            v_transfer.to_restaurant_id, v_dest_stock_item_id, v_quantity_received, 'transfer_in',
            'stock_transfer', p_transfer_id, p_user_id, now()
        );
    END LOOP;

    UPDATE public.stock_transfers
    SET status = 'RECEIVED', received_by = p_user_id, received_at = now()
    WHERE id = p_transfer_id;
END;
$$;

ALTER FUNCTION "public"."receive_transfer"(uuid, uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."receive_transfer"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."receive_transfer"(uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION "public"."cancel_transfer"(p_transfer_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer record;
BEGIN
    SELECT * INTO v_transfer
    FROM public.stock_transfers
    WHERE id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transfer % not found', p_transfer_id;
    END IF;

    IF v_transfer.status = 'CANCELLED' THEN
        RETURN; -- idempotent no-op
    END IF;

    -- No stock movement exists yet at DRAFT -- this is a pure status change.
    IF v_transfer.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'transfer % can only be cancelled while DRAFT (status=%)', p_transfer_id, v_transfer.status;
    END IF;

    UPDATE public.stock_transfers SET status = 'CANCELLED' WHERE id = p_transfer_id;
END;
$$;

ALTER FUNCTION "public"."cancel_transfer"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cancel_transfer"(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."cancel_transfer"(uuid, uuid) TO authenticated, service_role;
