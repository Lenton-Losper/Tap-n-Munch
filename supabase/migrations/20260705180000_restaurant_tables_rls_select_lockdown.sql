-- Lock down restaurant_tables SELECT at RLS layer (staging).
-- Staff reads via user_restaurant_ids(); guest/anon reads limited to active rows for QR/kiosk flows.
-- Writes remain service_role API routes only (admin/tables, tabs, orders).

ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_tables FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read tables" ON public.restaurant_tables;

CREATE POLICY "Staff can read their own restaurant's tables"
    ON public.restaurant_tables
    FOR SELECT
    TO authenticated
    USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

-- Guest QR/kiosk flows use the anon browser client for point lookups (restaurant_id + table_number).
-- Narrower than USING (true): only active ordering points are visible to unauthenticated guests.
CREATE POLICY "Guests can read active tables for ordering"
    ON public.restaurant_tables
    FOR SELECT
    TO anon
    USING (active IS TRUE);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.restaurant_tables FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.restaurant_tables FROM authenticated;

GRANT SELECT ON TABLE public.restaurant_tables TO anon;
GRANT SELECT ON TABLE public.restaurant_tables TO authenticated;
