-- Workstream 3 follow-up: close the transfer-vs-sale concurrency gap flagged during WS3
-- verification. deduct_recipe_stock now takes the SAME transaction-scoped advisory lock
-- dispatch_transfer uses (pg_advisory_xact_lock(hashtext(stock_item_id::text))),
-- immediately before posting its stock_movements row for that item -- so a concurrent
-- transfer dispatch (or another sale) on the same stock_item is forced to wait for this
-- transaction to commit before it can read the balance or post its own movement, instead
-- of racing it under READ COMMITTED with no coordination at all.
--
-- Purely additive: one PERFORM line plus an ORDER BY (for deadlock-avoidance, same
-- reasoning as dispatch_transfer locking items in a fixed order) added to the existing
-- recipe_items loop. No change to what gets deducted, the idempotency check, the
-- per-line-item exception handling, or any other recipe logic. This does NOT add a
-- sufficiency check to sales -- deduct_recipe_stock still deducts unconditionally once it
-- gets the lock; it only removes the previously-uncoordinated race on WHEN that happens
-- relative to a concurrent transfer dispatch or another sale.
CREATE OR REPLACE FUNCTION "public"."deduct_recipe_stock"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_order record;
    v_line_item jsonb;
    v_menu_item_id uuid;
    v_line_qty numeric;
    v_recipe_id uuid;
    v_recipe_item record;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."stock_movements"
        WHERE reference_type = 'order'
          AND reference_id = p_order_id
    ) THEN
        RETURN;
    END IF;

    SELECT id, restaurant_id, items
    INTO v_order
    FROM "public"."orders"
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_order.items IS NULL OR jsonb_typeof(v_order.items) <> 'array' THEN
        RETURN;
    END IF;

    FOR v_line_item IN
        SELECT value FROM jsonb_array_elements(v_order.items)
    LOOP
        BEGIN
            v_menu_item_id := COALESCE(
                (v_line_item->>'menu_item_id')::uuid,
                (v_line_item->>'menuItemId')::uuid
            );
            v_line_qty := COALESCE((v_line_item->>'quantity')::numeric, 1);

            IF v_menu_item_id IS NULL OR v_line_qty <= 0 THEN
                CONTINUE;
            END IF;

            SELECT id
            INTO v_recipe_id
            FROM "public"."recipes"
            WHERE restaurant_id = v_order.restaurant_id
              AND menu_item_id = v_menu_item_id
              AND is_active = true
            LIMIT 1;

            IF v_recipe_id IS NULL THEN
                CONTINUE;
            END IF;

            -- Ordered by stock_item_id so two concurrent multi-ingredient orders (or an
            -- order and a transfer) sharing overlapping items always acquire their
            -- advisory locks in the same relative order, avoiding a deadlock between them.
            FOR v_recipe_item IN
                SELECT stock_item_id, quantity
                FROM "public"."recipe_items"
                WHERE recipe_id = v_recipe_id
                ORDER BY stock_item_id
            LOOP
                PERFORM pg_advisory_xact_lock(hashtext(v_recipe_item.stock_item_id::text));

                INSERT INTO "public"."stock_movements" (
                    restaurant_id, stock_item_id, quantity_delta, reason,
                    reference_type, reference_id, created_by, created_at
                ) VALUES (
                    v_order.restaurant_id,
                    v_recipe_item.stock_item_id,
                    -(v_recipe_item.quantity * v_line_qty),
                    'sale',
                    'order',
                    p_order_id,
                    NULL,
                    now()
                );
            END LOOP;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'deduct_recipe_stock line item error for order %: %', p_order_id, SQLERRM;
        END;
    END LOOP;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'deduct_recipe_stock error for order %: %', p_order_id, SQLERRM;
END;
$$;
