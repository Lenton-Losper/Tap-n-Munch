-- Workstream 3 (1/3): stock_transfers / stock_transfer_items schema.
-- Builds on Workstream 2's organization_stock_items + the
-- (restaurant_id, organization_stock_item_id) WHERE is_active partial unique index on
-- stock_items -- that index is how dispatch/receive resolve each side's local stock_item.
--
-- No RLS/permissions/UI in this migration -- access goes entirely through the
-- SECURITY DEFINER dispatch_transfer/receive_transfer/cancel_transfer functions (and
-- service-role tooling) until a later workstream wires up policies.

CREATE TABLE IF NOT EXISTS "public"."stock_transfers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id"),
    "transfer_number" text NOT NULL UNIQUE,
    "from_restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id"),
    "to_restaurant_id" uuid NOT NULL REFERENCES "public"."restaurants"("id"),
    "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
    "created_by" uuid NOT NULL REFERENCES "public"."users"("id"),
    "dispatched_by" uuid REFERENCES "public"."users"("id"),
    "dispatched_at" timestamptz,
    "received_by" uuid REFERENCES "public"."users"("id"),
    "received_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CHECK ("from_restaurant_id" != "to_restaurant_id")
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_organization ON "public"."stock_transfers"("organization_id");
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_restaurant ON "public"."stock_transfers"("from_restaurant_id");
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_restaurant ON "public"."stock_transfers"("to_restaurant_id");

CREATE TABLE IF NOT EXISTS "public"."stock_transfer_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "transfer_id" uuid NOT NULL REFERENCES "public"."stock_transfers"("id") ON DELETE CASCADE,
    "organization_stock_item_id" uuid NOT NULL REFERENCES "public"."organization_stock_items"("id"),
    "quantity_sent" numeric NOT NULL CHECK ("quantity_sent" > 0),
    "quantity_received" numeric CHECK ("quantity_received" IS NULL OR "quantity_received" >= 0),
    "variance_reason" text,
    "unit_id" uuid NOT NULL REFERENCES "public"."measurement_units"("id"),
    UNIQUE ("transfer_id", "organization_stock_item_id")
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON "public"."stock_transfer_items"("transfer_id");
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_org_stock_item ON "public"."stock_transfer_items"("organization_stock_item_id");

-- transfer_number: TRF- + LPAD-6, same generate_document_number() mechanism as GRV-/RCT-
-- (global sequence, not per-organization -- matches the existing convention).
CREATE SEQUENCE IF NOT EXISTS "public"."trf_number_seq" START 1;

CREATE OR REPLACE FUNCTION "public"."assign_transfer_number"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.transfer_number IS NULL THEN
        NEW.transfer_number := public.generate_document_number('TRF', 'trf_number_seq');
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."assign_transfer_number"() OWNER TO "postgres";

CREATE OR REPLACE TRIGGER "trg_assign_transfer_number"
    BEFORE INSERT ON "public"."stock_transfers"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."assign_transfer_number"();

-- Structural cross-org guard, same philosophy/shape as Workstream 2's
-- enforce_stock_item_org_match: from_restaurant_id and to_restaurant_id must both belong
-- to stock_transfers.organization_id. Can't be a composite FK because it has to join
-- through restaurants.
CREATE OR REPLACE FUNCTION "public"."enforce_stock_transfer_org_match"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_from_org uuid;
    v_to_org uuid;
BEGIN
    SELECT organization_id INTO v_from_org FROM public.restaurants WHERE id = NEW.from_restaurant_id;
    SELECT organization_id INTO v_to_org FROM public.restaurants WHERE id = NEW.to_restaurant_id;

    IF v_from_org IS NULL OR v_from_org <> NEW.organization_id THEN
        RAISE EXCEPTION 'stock_transfers.from_restaurant_id % does not belong to organization %', NEW.from_restaurant_id, NEW.organization_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_to_org IS NULL OR v_to_org <> NEW.organization_id THEN
        RAISE EXCEPTION 'stock_transfers.to_restaurant_id % does not belong to organization %', NEW.to_restaurant_id, NEW.organization_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."enforce_stock_transfer_org_match"() OWNER TO "postgres";

CREATE OR REPLACE TRIGGER "trg_stock_transfers_enforce_org_match"
    BEFORE INSERT OR UPDATE OF "organization_id", "from_restaurant_id", "to_restaurant_id" ON "public"."stock_transfers"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_stock_transfer_org_match"();
