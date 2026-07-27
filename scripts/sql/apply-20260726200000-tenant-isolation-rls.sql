-- Multi-tenant isolation (Critical): enable + FORCE RLS on tables that had
-- policies but never ENABLE, then tighten grants/policies.
-- Staging first; production requires explicit sign-off.
--
-- Approach for restaurants: keep guest SELECT on the base table (QR/menu
-- clients already query it) but REVOKE access to merchant/payment columns
-- from anon/authenticated. Staff/service_role retain full access via
-- restaurant membership RLS + service_role bypass.
--
-- customer_sessions: service_role only (session tokens must not be client-readable).

-- ---------------------------------------------------------------------------
-- 0. Helper already exists: public.user_restaurant_ids()
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. TABS
-- ---------------------------------------------------------------------------
ALTER TABLE public.tabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tabs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can create tabs" ON public.tabs;
DROP POLICY IF EXISTS "Public can read tabs" ON public.tabs;
DROP POLICY IF EXISTS "Public can update tabs" ON public.tabs;

CREATE POLICY "Staff can select tabs for their restaurants"
  ON public.tabs
  FOR SELECT
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

CREATE POLICY "Staff can insert tabs for their restaurants"
  ON public.tabs
  FOR INSERT
  TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.user_restaurant_ids()));

CREATE POLICY "Staff can update tabs for their restaurants"
  ON public.tabs
  FOR UPDATE
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.user_restaurant_ids()));

-- Guest QR/tab landing reads active tabs via the browser anon client.
-- Deliberately excludes tab_pin via column grants below.
CREATE POLICY "Guests can read active tabs for ordering"
  ON public.tabs
  FOR SELECT
  TO anon
  USING (status IN ('open', 'ready_to_pay', 'settled'));

REVOKE ALL ON TABLE public.tabs FROM anon;
REVOKE ALL ON TABLE public.tabs FROM authenticated;

GRANT SELECT (
  id,
  restaurant_id,
  table_id,
  table_number,
  status,
  settled_type,
  total,
  members,
  payment_preference,
  ready_to_pay_at,
  pin_required,
  session_version,
  created_at,
  firebase_id,
  firebase_restaurant_id,
  settled_at,
  customer_name
) ON TABLE public.tabs TO anon;

GRANT SELECT, INSERT, UPDATE ON TABLE public.tabs TO authenticated;
GRANT ALL ON TABLE public.tabs TO service_role;

-- ---------------------------------------------------------------------------
-- 2. RESTAURANTS
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read restaurants" ON public.restaurants;
DROP POLICY IF EXISTS "Allow anon read" ON public.restaurants;
DROP POLICY IF EXISTS "Users can read own restaurant" ON public.restaurants;

-- Guest/menu clients need public-safe restaurant identity (QR URLs already
-- expose the restaurant UUID). Merchant/Finatic columns are NOT granted to anon.
CREATE POLICY "Guests can read public restaurant identity"
  ON public.restaurants
  FOR SELECT
  TO anon
  USING (deleted_at IS NULL);

CREATE POLICY "Staff can select restaurants they belong to"
  ON public.restaurants
  FOR SELECT
  TO authenticated
  USING (
    id IN (SELECT public.user_restaurant_ids())
    OR owner_id = auth.uid()
  );

CREATE POLICY "Staff can update restaurants they belong to"
  ON public.restaurants
  FOR UPDATE
  TO authenticated
  USING (
    id IN (SELECT public.user_restaurant_ids())
    OR owner_id = auth.uid()
  )
  WITH CHECK (
    id IN (SELECT public.user_restaurant_ids())
    OR owner_id = auth.uid()
  );

REVOKE ALL ON TABLE public.restaurants FROM anon;
REVOKE ALL ON TABLE public.restaurants FROM authenticated;

-- Public-safe columns only for anon (no finatic_*/checkout_*/terminals).
GRANT SELECT (
  id,
  name,
  slug,
  phone,
  logo_url,
  primary_color,
  currency,
  online_ordering_enabled,
  address,
  subdomain,
  timezone,
  is_active,
  created_at,
  updated_at,
  firebase_id,
  tab_pin_required
) ON TABLE public.restaurants TO anon;

-- Authenticated staff may read full row for restaurants they belong to (RLS).
GRANT SELECT, UPDATE ON TABLE public.restaurants TO authenticated;
GRANT ALL ON TABLE public.restaurants TO service_role;

-- ---------------------------------------------------------------------------
-- 3. USERS
-- ---------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own row" ON public.users;
DROP POLICY IF EXISTS "Users can update own row" ON public.users;
DROP POLICY IF EXISTS "Public can read users" ON public.users;

CREATE POLICY "Users can read own row"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update own row"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;

-- ---------------------------------------------------------------------------
-- 4. CUSTOMER_SESSIONS (session tokens — service_role only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read customer_sessions" ON public.customer_sessions;
DROP POLICY IF EXISTS "Public can create customer_sessions" ON public.customer_sessions;
DROP POLICY IF EXISTS "Public can update customer_sessions" ON public.customer_sessions;
DROP POLICY IF EXISTS "Allow anon read customer_sessions" ON public.customer_sessions;

-- No policies for anon/authenticated → deny-all for clients.
REVOKE ALL ON TABLE public.customer_sessions FROM anon;
REVOKE ALL ON TABLE public.customer_sessions FROM authenticated;
GRANT ALL ON TABLE public.customer_sessions TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Probe helper (service_role): confirm rowsecurity + force flags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_tenant_isolation_rls_status()
RETURNS TABLE (
  table_name text,
  rls_enabled boolean,
  rls_forced boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT
    c.relname::text,
    c.relrowsecurity,
    c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN ('tabs', 'restaurants', 'users', 'customer_sessions')
  ORDER BY c.relname;
$$;

REVOKE ALL ON FUNCTION public.list_tenant_isolation_rls_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_tenant_isolation_rls_status() TO service_role;
