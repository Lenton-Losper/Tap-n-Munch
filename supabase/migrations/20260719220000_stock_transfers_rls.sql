-- Workstream 4 (2/3): RLS for stock_transfers/stock_transfer_items, plus an additional
-- organization_users-backed read path on organization_stock_items.
--
-- No INSERT/UPDATE/DELETE policies on stock_transfers/stock_transfer_items -- all writes go
-- through the create_transfer/dispatch_transfer/receive_transfer/cancel_transfer SECURITY
-- DEFINER functions (service_role only, see 20260719230000), matching the existing
-- receipt_documents/receipt_deliveries pattern (function/service-role-only writes, no
-- client-writable policy).

ALTER TABLE "public"."stock_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."stock_transfer_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read transfers for their restaurant or organization"
    ON "public"."stock_transfers"
    FOR SELECT
    USING (
        "from_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
        OR "to_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
        OR "organization_id" IN (SELECT "organization_id" FROM "public"."organization_users" WHERE "user_id" = auth.uid())
    );

-- Follows through transfer_id to its parent, same shape as goods_received_items following
-- goods_received_id (20260630140000_fix_restaurant_users_rls_recursion.sql).
CREATE POLICY "Staff can read transfer items for their restaurant or organization"
    ON "public"."stock_transfer_items"
    FOR SELECT
    USING (
        "transfer_id" IN (
            SELECT "id" FROM "public"."stock_transfers"
            WHERE "from_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
               OR "to_restaurant_id" IN (SELECT "public"."user_restaurant_ids"())
               OR "organization_id" IN (SELECT "organization_id" FROM "public"."organization_users" WHERE "user_id" = auth.uid())
        )
    );

-- Additive: extends WS2's existing "Restaurant members can manage own org stock items"
-- (restaurant-membership-based, FOR ALL) with a second, SELECT-only permissive policy for
-- organization_users members -- covers an org OWNER who doesn't hold restaurant-level
-- access at every location in their own organization. RLS policies are OR'd together, so
-- this only ever adds read access, never narrows the existing policy.
CREATE POLICY "Organization members can read own org stock items"
    ON "public"."organization_stock_items"
    FOR SELECT
    USING (
        "organization_id" IN (SELECT "organization_id" FROM "public"."organization_users" WHERE "user_id" = auth.uid())
    );
