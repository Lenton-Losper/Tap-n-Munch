-- Sprint B: Stock Ledger Foundation
-- Scope: stock_items, goods_received, stock_movements only.
-- No UI, no recipes, no auto-deduction. Current stock = SUM(quantity_delta).

-- 1. stock_items: anything physically stocked (raw ingredient or finished product)
CREATE TABLE IF NOT EXISTS "public"."stock_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "unit_of_measure" text NOT NULL, -- e.g. 'unit', 'kg', 'l', 'g', 'ml'
    "is_purchasable" boolean NOT NULL DEFAULT true,
    "is_manufactured" boolean NOT NULL DEFAULT false,
    "is_active" boolean NOT NULL DEFAULT true,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_items_restaurant ON "public"."stock_items"("restaurant_id");

-- 2. goods_received: the GRV record itself (what arrived, from whom, at what cost)
CREATE TABLE IF NOT EXISTS "public"."goods_received" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "stock_item_id" uuid NOT NULL REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT,
    "quantity" numeric NOT NULL CHECK ("quantity" > 0),
    "unit_cost" numeric,
    "supplier" text,
    "received_by" uuid REFERENCES "public"."users"("id"),
    "received_at" timestamptz NOT NULL DEFAULT now(),
    "notes" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goods_received_restaurant ON "public"."goods_received"("restaurant_id");
CREATE INDEX IF NOT EXISTS idx_goods_received_stock_item ON "public"."goods_received"("stock_item_id");

-- 3. stock_movements: the ledger itself. Every change to stock is a row here.
CREATE TABLE IF NOT EXISTS "public"."stock_movements" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "stock_item_id" uuid NOT NULL REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT,
    "quantity_delta" numeric NOT NULL,
    "reason" text NOT NULL CHECK ("reason" IN ('received', 'adjustment', 'loss', 'theft', 'recount', 'sale')),
    "reference_type" text,
    "reference_id" uuid,
    "created_by" uuid REFERENCES "public"."users"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "notes" text
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_restaurant ON "public"."stock_movements"("restaurant_id");
CREATE INDEX IF NOT EXISTS idx_stock_movements_stock_item ON "public"."stock_movements"("stock_item_id");
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON "public"."stock_movements"("reference_type", "reference_id");

-- RLS: owner-scoped read/write, mirroring existing restaurant-scoped tables
ALTER TABLE "public"."stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."goods_received" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."stock_movements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage own restaurant stock items"
    ON "public"."stock_items"
    FOR ALL
    USING (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()))
    WITH CHECK (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()));

CREATE POLICY "Owners can manage own restaurant goods received"
    ON "public"."goods_received"
    FOR ALL
    USING (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()))
    WITH CHECK (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()));

CREATE POLICY "Owners can manage own restaurant stock movements"
    ON "public"."stock_movements"
    FOR ALL
    USING (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()))
    WITH CHECK (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()));

-- Trigger: every goods_received insert automatically creates its stock_movements row
CREATE OR REPLACE FUNCTION "public"."create_movement_from_goods_received"()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "public"."stock_movements" (
        restaurant_id, stock_item_id, quantity_delta, reason,
        reference_type, reference_id, created_by, created_at
    ) VALUES (
        NEW.restaurant_id, NEW.stock_item_id, NEW.quantity, 'received',
        'goods_received', NEW.id, NEW.received_by, NEW.received_at
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_goods_received_creates_movement
    AFTER INSERT ON "public"."goods_received"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."create_movement_from_goods_received"();
