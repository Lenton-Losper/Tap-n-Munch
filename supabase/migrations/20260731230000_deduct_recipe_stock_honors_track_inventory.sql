-- deduct_recipe_stock must honour menu_items.track_inventory, not just recipes.is_active.
--
-- Tracking state lives in two places that nothing keeps in sync: menu_items.track_inventory
-- (what every UI reads) and recipes.is_active + recipe_items (what deduction keys on).
-- Deduction only ever consulted the second, so unticking "Track inventory" did not stop
-- stock being deducted. The item read as untracked on every screen while its stock kept
-- draining, and there is no UI path that deactivates a recipe -- unticking the toggle is the
-- only lever a merchant has, and it did not do what it said.
--
-- Measured on production immediately before this change:
--   23 active recipes; 2 with menu_items.track_inventory = false (FNB ChowNow "Beef Stew"
--   and "Lamb Chop", both status 'hidden', so 0 currently sellable); 21 with true; and
--   0 with NULL. Because there are no NULLs, this stops deduction ONLY for those two
--   explicitly-false items, which is the intended outcome -- no backfill is required.
--   No non-terminal order and no open order_request referenced either item.
--
-- The ONLY change is the recipe lookup now joining menu_items and requiring
-- track_inventory = true. The idempotency guard, the advisory locking and its ORDER BY, the
-- per-line-item exception isolation, and the quantities deducted are all untouched.
--
-- NOTE for anyone adding a sufficiency check here later: this function is invoked from an
-- AFTER UPDATE OF status trigger that fires when an order is already being marked
-- 'completed', and it deliberately swallows every exception into a WARNING so a recipe
-- misconfiguration cannot block order completion. Raising here would therefore either be
-- swallowed (no effect) or, with the handlers removed, strand orders that cannot be
-- completed. A "block the sale" rule belongs earlier -- at order placement or acceptance --
-- not at completion, where the customer has already been served.
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

            -- Both halves of the tracking state must agree before anything is deducted: an
            -- active recipe AND the menu item actually flagged as tracked. track_inventory
            -- is compared with IS TRUE so a NULL is treated as "not tracked" rather than
            -- silently deducting.
            SELECT r.id
            INTO v_recipe_id
            FROM "public"."recipes" r
            JOIN "public"."menu_items" m
              ON m.id = r.menu_item_id
             AND m.restaurant_id = r.restaurant_id
            WHERE r.restaurant_id = v_order.restaurant_id
              AND r.menu_item_id = v_menu_item_id
              AND r.is_active = true
              AND m.track_inventory IS TRUE
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
