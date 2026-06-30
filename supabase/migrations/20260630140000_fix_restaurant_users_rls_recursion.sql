CREATE OR REPLACE FUNCTION "public"."user_restaurant_ids"()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid();
$$;

DROP POLICY IF EXISTS "Users can read team in their restaurant" ON "public"."restaurant_users";

CREATE POLICY "Users can read team in their restaurant"
    ON "public"."restaurant_users"
    FOR SELECT
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));

DROP POLICY IF EXISTS "Owners can manage own restaurant stock items" ON "public"."stock_items";
CREATE POLICY "Owners can manage own restaurant stock items"
    ON "public"."stock_items"
    FOR ALL
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));

DROP POLICY IF EXISTS "Owners can manage own restaurant goods received" ON "public"."goods_received";
CREATE POLICY "Owners can manage own restaurant goods received"
    ON "public"."goods_received"
    FOR ALL
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));

DROP POLICY IF EXISTS "Owners can manage own restaurant goods received items" ON "public"."goods_received_items";
CREATE POLICY "Owners can manage own restaurant goods received items"
    ON "public"."goods_received_items"
    FOR ALL
    USING (goods_received_id IN (
        SELECT id FROM goods_received WHERE restaurant_id IN (SELECT "public"."user_restaurant_ids"())
    ))
    WITH CHECK (goods_received_id IN (
        SELECT id FROM goods_received WHERE restaurant_id IN (SELECT "public"."user_restaurant_ids"())
    ));

DROP POLICY IF EXISTS "Owners can manage own restaurant stock movements" ON "public"."stock_movements";
CREATE POLICY "Owners can manage own restaurant stock movements"
    ON "public"."stock_movements"
    FOR ALL
    USING (restaurant_id IN (SELECT "public"."user_restaurant_ids"()))
    WITH CHECK (restaurant_id IN (SELECT "public"."user_restaurant_ids"()));
