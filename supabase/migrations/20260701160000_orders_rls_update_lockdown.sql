-- P0: Lock down orders mutations at RLS + privilege level (staging).
-- API routes use service_role; guests keep INSERT; staff mutate via authenticated API routes.

ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."orders" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can update orders" ON "public"."orders";
DROP POLICY IF EXISTS "service role can update orders" ON "public"."orders";
DROP POLICY IF EXISTS "Staff can update orders for their restaurant" ON "public"."orders";
DROP POLICY IF EXISTS "Guest can mark order ready for terminal" ON "public"."orders";

CREATE POLICY "Staff can update orders for their restaurant"
    ON "public"."orders"
    FOR UPDATE
    TO "authenticated"
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));

CREATE POLICY "Guest can mark order ready for terminal"
    ON "public"."orders"
    FOR UPDATE
    TO "anon"
    USING (
        COALESCE(is_closed, false) = false
        AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
    )
    WITH CHECK (status = 'ready_for_terminal');

REVOKE UPDATE, DELETE ON TABLE "public"."orders" FROM "anon";
REVOKE UPDATE, DELETE ON TABLE "public"."orders" FROM "authenticated";

GRANT UPDATE (status, customer_ready_to_pay) ON TABLE "public"."orders" TO "anon";
