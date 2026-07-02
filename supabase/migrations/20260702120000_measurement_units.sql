-- Sprint B: measurement_units reference table (staging)
-- Replaces free-text base_unit on stock_items and unit on recipe_items.

-- 1. measurement_units
CREATE TABLE IF NOT EXISTS "public"."measurement_units" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "symbol" text,
    "is_system" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("restaurant_id", "name")
);

CREATE INDEX IF NOT EXISTS idx_measurement_units_restaurant ON "public"."measurement_units"("restaurant_id");

-- 2. Seed system units (restaurant_id NULL, is_system true)
INSERT INTO "public"."measurement_units" ("restaurant_id", "name", "symbol", "is_system")
SELECT NULL, 'kg', 'kg', true
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."measurement_units" WHERE "restaurant_id" IS NULL AND "name" = 'kg'
);

INSERT INTO "public"."measurement_units" ("restaurant_id", "name", "symbol", "is_system")
SELECT NULL, 'g', 'g', true
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."measurement_units" WHERE "restaurant_id" IS NULL AND "name" = 'g'
);

INSERT INTO "public"."measurement_units" ("restaurant_id", "name", "symbol", "is_system")
SELECT NULL, 'l', 'L', true
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."measurement_units" WHERE "restaurant_id" IS NULL AND "name" = 'l'
);

INSERT INTO "public"."measurement_units" ("restaurant_id", "name", "symbol", "is_system")
SELECT NULL, 'ml', 'ml', true
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."measurement_units" WHERE "restaurant_id" IS NULL AND "name" = 'ml'
);

INSERT INTO "public"."measurement_units" ("restaurant_id", "name", "symbol", "is_system")
SELECT NULL, 'unit', '—', true
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."measurement_units" WHERE "restaurant_id" IS NULL AND "name" = 'unit'
);

-- 3. RLS
ALTER TABLE "public"."measurement_units" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read system measurement units" ON "public"."measurement_units";
CREATE POLICY "Authenticated users can read system measurement units"
    ON "public"."measurement_units"
    FOR SELECT
    TO "authenticated"
    USING ("restaurant_id" IS NULL);

DROP POLICY IF EXISTS "Owners can manage own restaurant measurement units" ON "public"."measurement_units";
CREATE POLICY "Owners can manage own restaurant measurement units"
    ON "public"."measurement_units"
    FOR ALL
    USING (
        "restaurant_id" IS NOT NULL
        AND "restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
    )
    WITH CHECK (
        "restaurant_id" IS NOT NULL
        AND "restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
    );

-- 4. stock_items: unit_id replaces base_unit
ALTER TABLE "public"."stock_items"
    ADD COLUMN IF NOT EXISTS "unit_id" uuid REFERENCES "public"."measurement_units"("id") ON DELETE RESTRICT;

UPDATE "public"."stock_items" si
SET "unit_id" = mu."id"
FROM "public"."measurement_units" mu
WHERE si."unit_id" IS NULL
  AND mu."restaurant_id" IS NULL
  AND lower(mu."name") = lower(si."base_unit");

UPDATE "public"."stock_items" si
SET "unit_id" = mu."id"
FROM "public"."measurement_units" mu
WHERE si."unit_id" IS NULL
  AND mu."restaurant_id" IS NULL
  AND mu."name" = 'unit';

ALTER TABLE "public"."stock_items" DROP COLUMN IF EXISTS "base_unit";

ALTER TABLE "public"."stock_items"
    ALTER COLUMN "unit_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_items_unit ON "public"."stock_items"("unit_id");

-- 5. recipe_items: unit_id replaces unit text
ALTER TABLE "public"."recipe_items"
    ADD COLUMN IF NOT EXISTS "unit_id" uuid REFERENCES "public"."measurement_units"("id") ON DELETE RESTRICT;

UPDATE "public"."recipe_items" ri
SET "unit_id" = mu."id"
FROM "public"."measurement_units" mu
WHERE ri."unit_id" IS NULL
  AND ri."unit" IS NOT NULL
  AND mu."restaurant_id" IS NULL
  AND lower(mu."name") = lower(ri."unit");

UPDATE "public"."recipe_items" ri
SET "unit_id" = si."unit_id"
FROM "public"."stock_items" si
WHERE ri."unit_id" IS NULL
  AND ri."stock_item_id" = si."id";

UPDATE "public"."recipe_items" ri
SET "unit_id" = mu."id"
FROM "public"."measurement_units" mu
WHERE ri."unit_id" IS NULL
  AND mu."restaurant_id" IS NULL
  AND mu."name" = 'unit';

ALTER TABLE "public"."recipe_items" DROP COLUMN IF EXISTS "unit";

ALTER TABLE "public"."recipe_items"
    ALTER COLUMN "unit_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recipe_items_unit ON "public"."recipe_items"("unit_id");

-- 6. goods_received.invoice_number — ensure nullable
ALTER TABLE "public"."goods_received"
    ALTER COLUMN "invoice_number" DROP NOT NULL;
