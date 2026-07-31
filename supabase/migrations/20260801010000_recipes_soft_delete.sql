-- Soft-delete for recipes: tombstone rather than erase.
--
-- Removing a stock link should not destroy the record of what the recipe was. A deleted
-- recipe keeps its row and its ingredients and gains a deleted_at marker, so the history
-- stays inspectable and the state is explicit rather than inferred from an absence.
--
-- The danger with a tombstone is that it becomes exactly the ambiguous half-state it was
-- meant to replace: a row that exists, is invisible on one screen, and still behaves on
-- another. That is precisely the bug class fixed earlier tonight (a live recipe on an
-- untracked item kept draining stock). So EVERY read path must exclude deleted rows. The two
-- SQL ones are updated here; the TypeScript ones (lib/recipes/queries.ts,
-- lib/recipes/actions.ts, lib/orders/check-stock-sufficiency.ts) are updated alongside.
--
-- recipes has UNIQUE (restaurant_id, menu_item_id), so a tombstoned row still occupies that
-- slot. Re-linking therefore REVIVES the existing row (clears deleted_at) rather than
-- inserting a second one -- saveRecipeAction already reuses an existing recipe, so this needs
-- no schema change and no partial index.

ALTER TABLE "public"."recipes"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

COMMENT ON COLUMN "public"."recipes"."deleted_at" IS
  'Set when the merchant removes the stock link. The row and its recipe_items are retained as '
  'a record of what the recipe was. Every read path must exclude rows where this is not null.';

-- Deleted recipes must never deduct stock.
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

            -- Active recipe, menu item flagged as tracked, AND not tombstoned.
            SELECT r.id
            INTO v_recipe_id
            FROM "public"."recipes" r
            JOIN "public"."menu_items" m
              ON m.id = r.menu_item_id
             AND m.restaurant_id = r.restaurant_id
            WHERE r.restaurant_id = v_order.restaurant_id
              AND r.menu_item_id = v_menu_item_id
              AND r.is_active = true
              AND r.deleted_at IS NULL
              AND m.track_inventory IS TRUE
            LIMIT 1;

            IF v_recipe_id IS NULL THEN
                CONTINUE;
            END IF;

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

-- A deleted recipe must not make an item unsellable either: with no live link, there is
-- nothing to check, so the item simply sells.
CREATE OR REPLACE FUNCTION "public"."check_stock_sufficiency_locked"(
    "p_restaurant_id" uuid,
    "p_menu_item_ids" uuid[]
)
RETURNS TABLE (
    menu_item_id uuid,
    menu_item_name text,
    stock_item_id uuid,
    stock_item_name text,
    balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stock_ids uuid[];
BEGIN
    SELECT array_agg(DISTINCT ri.stock_item_id ORDER BY ri.stock_item_id)
      INTO v_stock_ids
      FROM recipes r
      JOIN menu_items m
        ON m.id = r.menu_item_id
       AND m.restaurant_id = r.restaurant_id
      JOIN recipe_items ri
        ON ri.recipe_id = r.id
     WHERE r.restaurant_id = p_restaurant_id
       AND r.menu_item_id = ANY(p_menu_item_ids)
       AND r.is_active = true
       AND r.deleted_at IS NULL
       AND m.track_inventory IS TRUE;

    IF v_stock_ids IS NULL OR array_length(v_stock_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    PERFORM 1
       FROM stock_items si
      WHERE si.id = ANY(v_stock_ids)
      ORDER BY si.id
        FOR UPDATE;

    RETURN QUERY
    SELECT m.id,
           m.name,
           si.id,
           si.name,
           COALESCE(bal.total, 0)
      FROM recipes r
      JOIN menu_items m
        ON m.id = r.menu_item_id
       AND m.restaurant_id = r.restaurant_id
      JOIN recipe_items ri
        ON ri.recipe_id = r.id
      JOIN stock_items si
        ON si.id = ri.stock_item_id
      LEFT JOIN LATERAL (
           SELECT SUM(sm.quantity_delta) AS total
             FROM stock_movements sm
            WHERE sm.stock_item_id = ri.stock_item_id
      ) bal ON true
     WHERE r.restaurant_id = p_restaurant_id
       AND r.menu_item_id = ANY(p_menu_item_ids)
       AND r.is_active = true
       AND r.deleted_at IS NULL
       AND m.track_inventory IS TRUE
       AND COALESCE(bal.total, 0) <= 0;
END;
$$;

REVOKE ALL ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) TO service_role;
