-- Stage 2 (staging): lock down permissive orders SELECT policies.
-- Guest reads go through service-role API routes (Stage 1). Staff reads via user_restaurant_ids().

CREATE OR REPLACE FUNCTION public.user_restaurant_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()
    UNION
    SELECT id FROM restaurants WHERE owner_id = auth.uid();
$$;

DROP POLICY IF EXISTS "Allow anon read orders" ON public.orders;
DROP POLICY IF EXISTS "anon can read orders" ON public.orders;
DROP POLICY IF EXISTS "Public can read orders" ON public.orders;
DROP POLICY IF EXISTS "Public can read open orders" ON public.orders;
DROP POLICY IF EXISTS "Staff can read orders for their restaurant" ON public.orders;

CREATE POLICY "Staff can read orders for their restaurants"
    ON public.orders
    FOR SELECT
    TO authenticated
    USING (restaurant_id IN (SELECT public.user_restaurant_ids()));
