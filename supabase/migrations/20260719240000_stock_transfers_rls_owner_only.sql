-- Workstream 4 fix: the organization_users read path on stock_transfers/stock_transfer_items
-- must be OWNER-only, not any organization_users row. As originally written, any MEMBER row
-- would also satisfy "organization_id IN (SELECT organization_id FROM organization_users
-- WHERE user_id = auth.uid())" with no role filter -- verified for real against staging and
-- confirmed a MEMBER could read a transfer they have no restaurant-level access to.
--
-- This contradicts Workstream 2's stated role semantics (only OWNER carries organization-wide
-- visibility/cross-location access in v1; MEMBER grants nothing extra yet) and this
-- workstream's own authorizeOrganization() (returns false for MEMBER) and verification
-- requirement ("a MEMBER... cannot [view all transfers], unless they separately hold
-- restaurant-level access"). Restricting to role = 'OWNER' to match.
--
-- organization_stock_items' organization_users read path is deliberately left unqualified
-- (no role filter) -- item-catalog visibility across an org's own locations was never scoped
-- to OWNER-only by any requirement here, unlike transfer visibility.

DROP POLICY IF EXISTS "Staff can read transfers for their restaurant or organization" ON "public"."stock_transfers";
CREATE POLICY "Staff can read transfers for their restaurant or organization"
    ON "public"."stock_transfers"
    FOR SELECT
    USING (
        "from_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
        OR "to_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
        OR "organization_id" IN (
            SELECT "organization_id" FROM "public"."organization_users"
            WHERE "user_id" = auth.uid() AND "role" = 'OWNER'
        )
    );

DROP POLICY IF EXISTS "Staff can read transfer items for their restaurant or organization" ON "public"."stock_transfer_items";
CREATE POLICY "Staff can read transfer items for their restaurant or organization"
    ON "public"."stock_transfer_items"
    FOR SELECT
    USING (
        "transfer_id" IN (
            SELECT "id" FROM "public"."stock_transfers"
            WHERE "from_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
               OR "to_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
               OR "organization_id" IN (
                    SELECT "organization_id" FROM "public"."organization_users"
                    WHERE "user_id" = auth.uid() AND "role" = 'OWNER'
               )
        )
    );
