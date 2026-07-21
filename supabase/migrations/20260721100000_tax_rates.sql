-- Per-item VAT, Phase A: tax_rates reference table (restaurant-scoped) + menu_items.tax_rate_id.
-- No calculation logic here -- schema and configuration UI only.

-- 1. tax_rates
CREATE TABLE IF NOT EXISTS "public"."tax_rates" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "percentage" numeric NOT NULL CHECK ("percentage" >= 0),
    "is_inclusive" boolean NOT NULL DEFAULT true,
    "is_default" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_restaurant ON "public"."tax_rates"("restaurant_id");

-- Only one default rate per restaurant -- enforced here, not just in the app layer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_rates_one_default_per_restaurant
    ON "public"."tax_rates"("restaurant_id")
    WHERE "is_default" = true;

-- 2. RLS: restaurant-scoped read/write, mirroring measurement_units' owner-managed policy.
ALTER TABLE "public"."tax_rates" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can manage own restaurant tax rates" ON "public"."tax_rates";
CREATE POLICY "Owners can manage own restaurant tax rates"
    ON "public"."tax_rates"
    FOR ALL
    USING ("restaurant_id" IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK ("restaurant_id" IN (SELECT "public"."user_restaurant_ids"()));

-- 3. menu_items.tax_rate_id
-- Nullable: null = restaurant's default rate applies (if one exists), or 0% if no default is set,
-- matching today's behavior exactly for anything unconfigured. ON DELETE SET NULL so removing a
-- rate falls items back to that same "unconfigured" behavior rather than failing.
ALTER TABLE "public"."menu_items"
    ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid REFERENCES "public"."tax_rates"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_menu_items_tax_rate ON "public"."menu_items"("tax_rate_id");
