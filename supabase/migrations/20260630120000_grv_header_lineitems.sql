-- Sprint B revision: GRV header/line-item split + unit conversion room + permissions prep
-- Rationale: a real delivery has multiple items on one invoice. goods_received becomes
-- the document header; goods_received_items holds the line items. Each line item insert
-- still creates its own stock_movements row (one movement per item, not per invoice).
-- Tables are empty on staging — safe to drop and recreate rather than ALTER.

DROP TRIGGER IF EXISTS trg_goods_received_creates_movement ON "public"."goods_received";
DROP FUNCTION IF EXISTS "public"."create_movement_from_goods_received"();
DROP TABLE IF EXISTS "public"."goods_received" CASCADE;

-- 1. stock_items: rename unit_of_measure -> base_unit, add room for future conversion
ALTER TABLE "public"."stock_items" RENAME COLUMN "unit_of_measure" TO "base_unit";
ALTER TABLE "public"."stock_items" ADD COLUMN IF NOT EXISTS "purchase_unit" text;
ALTER TABLE "public"."stock_items" ADD COLUMN IF NOT EXISTS "conversion_factor" numeric;

-- 2. goods_received: now the document header, not a per-item row
CREATE TABLE "public"."goods_received" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "supplier" text,
    "invoice_number" text,
    "received_by" uuid REFERENCES "public"."users"("id"),
    "received_at" timestamptz NOT NULL DEFAULT now(),
    "notes" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_goods_received_restaurant ON "public"."goods_received"("restaurant_id");
CREATE INDEX idx_goods_received_invoice ON "public"."goods_received"("invoice_number");

-- 3. goods_received_items: the line items on a single GRV (one per stock_item received)
CREATE TABLE "public"."goods_received_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "goods_received_id" uuid NOT NULL REFERENCES "public"."goods_received"("id") ON DELETE CASCADE,
    "stock_item_id" uuid NOT NULL REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT,
    "quantity" numeric NOT NULL CHECK ("quantity" > 0),
    "unit_cost" numeric,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_goods_received_items_grv ON "public"."goods_received_items"("goods_received_id");
CREATE INDEX idx_goods_received_items_stock_item ON "public"."goods_received_items"("stock_item_id");

ALTER TABLE "public"."goods_received" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."goods_received_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage own restaurant goods received"
    ON "public"."goods_received"
    FOR ALL
    USING (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()))
    WITH CHECK (restaurant_id IN (SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()));

CREATE POLICY "Owners can manage own restaurant goods received items"
    ON "public"."goods_received_items"
    FOR ALL
    USING (goods_received_id IN (
        SELECT id FROM goods_received WHERE restaurant_id IN (
            SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()
        )
    ))
    WITH CHECK (goods_received_id IN (
        SELECT id FROM goods_received WHERE restaurant_id IN (
            SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()
        )
    ));

CREATE OR REPLACE FUNCTION "public"."create_movement_from_goods_received_item"()
RETURNS TRIGGER AS $$
DECLARE
    v_restaurant_id uuid;
    v_received_by uuid;
    v_received_at timestamptz;
BEGIN
    SELECT restaurant_id, received_by, received_at
    INTO v_restaurant_id, v_received_by, v_received_at
    FROM "public"."goods_received"
    WHERE id = NEW.goods_received_id;

    INSERT INTO "public"."stock_movements" (
        restaurant_id, stock_item_id, quantity_delta, reason,
        reference_type, reference_id, created_by, created_at
    ) VALUES (
        v_restaurant_id, NEW.stock_item_id, NEW.quantity, 'received',
        'goods_received_items', NEW.id, v_received_by, v_received_at
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_goods_received_items_creates_movement
    AFTER INSERT ON "public"."goods_received_items"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."create_movement_from_goods_received_item"();
