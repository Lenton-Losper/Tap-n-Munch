-- Workstream 2 (3/5): canonical item identity, additive only.
-- organization_stock_item_id starts nullable; NOT NULL is added in a later migration
-- (20260719150000) only after the backfill (20260719140000) is verified on staging.
--
-- Does not touch recipes, recipe_items, goods_received_items, stock_movements, or
-- deduct_recipe_stock -- they key off stock_items.id, which is unchanged.

CREATE TABLE IF NOT EXISTS "public"."organization_stock_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "base_unit_id" uuid NOT NULL REFERENCES "public"."measurement_units"("id"),
    "is_manufactured" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_stock_items_organization ON "public"."organization_stock_items"("organization_id");

ALTER TABLE "public"."stock_items"
    ADD COLUMN IF NOT EXISTS "organization_stock_item_id" uuid REFERENCES "public"."organization_stock_items"("id");

CREATE INDEX IF NOT EXISTS idx_stock_items_organization_stock_item ON "public"."stock_items"("organization_stock_item_id");

CREATE UNIQUE INDEX IF NOT EXISTS stock_items_one_per_org_item_per_restaurant
    ON "public"."stock_items" ("restaurant_id", "organization_stock_item_id")
    WHERE "is_active" = true;

-- Structural cross-org guard (same philosophy as the transfer-level check coming in
-- Workstream 3): a stock_item's organization_stock_item_id must belong to the same
-- organization as the stock_item's own restaurant. This can't be expressed as a plain
-- composite FK (unlike restaurant_users_role_slug_fkey) because it has to join through
-- both restaurants and organization_stock_items, so it's enforced with a trigger instead.
CREATE OR REPLACE FUNCTION "public"."enforce_stock_item_org_match"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_restaurant_org uuid;
    v_item_org uuid;
BEGIN
    IF NEW.organization_stock_item_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT organization_id INTO v_restaurant_org
    FROM public.restaurants
    WHERE id = NEW.restaurant_id;

    SELECT organization_id INTO v_item_org
    FROM public.organization_stock_items
    WHERE id = NEW.organization_stock_item_id;

    IF v_restaurant_org IS NULL OR v_item_org IS NULL OR v_restaurant_org <> v_item_org THEN
        RAISE EXCEPTION 'stock_items.organization_stock_item_id % does not belong to the same organization as restaurant %', NEW.organization_stock_item_id, NEW.restaurant_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."enforce_stock_item_org_match"() OWNER TO "postgres";

CREATE OR REPLACE TRIGGER "trg_stock_items_enforce_org_match"
    BEFORE INSERT OR UPDATE OF "organization_stock_item_id", "restaurant_id" ON "public"."stock_items"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_stock_item_org_match"();

ALTER TABLE "public"."organization_stock_items" ENABLE ROW LEVEL SECURITY;

-- Keyed off restaurant membership (not organization_users/OWNER-only) because canonical
-- item creation happens as part of ordinary per-location stock actions (createStockItemAction),
-- performed by any staff member with stock permissions at that restaurant -- not just the
-- org owner. This grants no visibility into other locations' stock_items/stock_movements;
-- it only lets a location's staff read/write the shared canonical catalog for their own org,
-- which today is 1:1 with their single restaurant anyway.
CREATE POLICY "Restaurant members can manage own org stock items"
    ON "public"."organization_stock_items"
    FOR ALL
    USING (
        "organization_id" IN (
            SELECT r.organization_id FROM public.restaurants r
            WHERE r.id IN (SELECT public.user_restaurant_ids())
        )
    )
    WITH CHECK (
        "organization_id" IN (
            SELECT r.organization_id FROM public.restaurants r
            WHERE r.id IN (SELECT public.user_restaurant_ids())
        )
    );
