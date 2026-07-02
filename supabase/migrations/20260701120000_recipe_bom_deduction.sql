-- Recipe/BOM auto-deduction on order completion (staging rollout)
-- Follows Sprint B stock_movements conventions: same insert shape as GRV line-item trigger.

-- 1. recipes: one active BOM per menu item per restaurant
CREATE TABLE "public"."recipes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "menu_item_id" uuid NOT NULL REFERENCES "public"."menu_items"("id") ON DELETE CASCADE,
    "name" text,
    "is_active" boolean NOT NULL DEFAULT true,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("restaurant_id", "menu_item_id")
);

CREATE INDEX idx_recipes_restaurant ON "public"."recipes"("restaurant_id");
CREATE INDEX idx_recipes_menu_item ON "public"."recipes"("menu_item_id");

-- 2. recipe_items: ingredients consumed per unit of menu item
CREATE TABLE "public"."recipe_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "recipe_id" uuid NOT NULL REFERENCES "public"."recipes"("id") ON DELETE CASCADE,
    "stock_item_id" uuid NOT NULL REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT,
    "quantity" numeric NOT NULL CHECK ("quantity" > 0),
    "unit" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recipe_items_recipe ON "public"."recipe_items"("recipe_id");
CREATE INDEX idx_recipe_items_stock_item ON "public"."recipe_items"("stock_item_id");

-- 3. RLS: same user_restaurant_ids() SECURITY DEFINER pattern as stock_items / stock_movements
ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."recipe_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage own restaurant recipes"
    ON "public"."recipes"
    FOR ALL
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));

CREATE POLICY "Owners can manage own restaurant recipe items"
    ON "public"."recipe_items"
    FOR ALL
    USING (recipe_id IN (
        SELECT id FROM "public"."recipes"
        WHERE restaurant_id IN (SELECT "public"."user_restaurant_ids"())
    ))
    WITH CHECK (recipe_id IN (
        SELECT id FROM "public"."recipes"
        WHERE restaurant_id IN (SELECT "public"."user_restaurant_ids"())
    ));

-- 4. deduct_recipe_stock: all business logic; trigger only delegates here
CREATE OR REPLACE FUNCTION "public"."deduct_recipe_stock"(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_order record;
    v_line_item jsonb;
    v_menu_item_id uuid;
    v_line_qty numeric;
    v_recipe_id uuid;
    v_recipe_item record;
BEGIN
    -- Idempotency: one deduction pass per order
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

            FOR v_recipe_item IN
                SELECT stock_item_id, quantity
                FROM "public"."recipe_items"
                WHERE recipe_id = v_recipe_id
            LOOP
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

-- 5. Trigger: fires when order status transitions to completed
CREATE OR REPLACE FUNCTION "public"."trg_order_completion_deducts_stock"()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM "public"."deduct_recipe_stock"(NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_completion_deducts_stock
    AFTER UPDATE OF status ON "public"."orders"
    FOR EACH ROW
    WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
    EXECUTE FUNCTION "public"."trg_order_completion_deducts_stock"();
