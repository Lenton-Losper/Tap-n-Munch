-- Break RLS recursion: business_documents / restaurant_billing_profiles policies
-- subquery restaurant_roles, whose FOR ALL policy also subqueries restaurant_roles.

CREATE OR REPLACE FUNCTION public.user_has_permission(
  p_restaurant_id uuid,
  p_permission text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.restaurant_users ru
    WHERE ru.user_id = auth.uid()
      AND ru.restaurant_id = p_restaurant_id
      AND ru.deleted_at IS NULL
      AND (
        ru.role IN ('owner', 'manager')
        OR EXISTS (
          SELECT 1
          FROM public.restaurant_roles rr
          WHERE rr.restaurant_id = ru.restaurant_id
            AND rr.role_slug = ru.role
            AND p_permission = ANY (rr.permissions)
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_has_permission(uuid, text) TO authenticated, service_role;

-- restaurant_billing_profiles
DROP POLICY IF EXISTS "Authorized staff can read restaurant billing profiles"
  ON public.restaurant_billing_profiles;

CREATE POLICY "Authorized staff can read restaurant billing profiles"
  ON public.restaurant_billing_profiles
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'documents:read'));

DROP POLICY IF EXISTS "Authorized staff can write restaurant billing profiles"
  ON public.restaurant_billing_profiles;

CREATE POLICY "Authorized staff can write restaurant billing profiles"
  ON public.restaurant_billing_profiles
  FOR ALL
  USING (public.user_has_permission(restaurant_id, 'documents:write'))
  WITH CHECK (public.user_has_permission(restaurant_id, 'documents:write'));

-- business_documents
DROP POLICY IF EXISTS "Authorized staff can read business documents"
  ON public.business_documents;

CREATE POLICY "Authorized staff can read business documents"
  ON public.business_documents
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'documents:read'));

DROP POLICY IF EXISTS "Authorized staff can write business documents"
  ON public.business_documents;

CREATE POLICY "Authorized staff can write business documents"
  ON public.business_documents
  FOR ALL
  USING (public.user_has_permission(restaurant_id, 'documents:write'))
  WITH CHECK (public.user_has_permission(restaurant_id, 'documents:write'));
