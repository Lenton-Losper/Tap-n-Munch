-- Super Admin Dashboard (#13): centralize the platform_admins membership check into a
-- SECURITY DEFINER helper, mirroring the user_has_permission()/user_restaurant_ids() pattern
-- used for restaurant-level RLS. Kept completely separate from restaurant_roles/restaurant_users
-- -- platform-admin access must never be derived from or confused with a restaurant role.
--
-- platform_admins itself is unchanged (already existed, additive-only philosophy applies here).

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated, service_role;
