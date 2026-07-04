-- Authorization v2 Phase 2: DB-backed role permissions (schema only).
-- Permissions are seeded in 20260704161000_auth_v2_restaurant_roles_seed.sql.

CREATE TABLE IF NOT EXISTS public.restaurant_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  role_slug text NOT NULL,
  display_name text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, role_slug)
);

CREATE INDEX IF NOT EXISTS restaurant_roles_restaurant_id_idx
  ON public.restaurant_roles (restaurant_id);

ALTER TABLE public.restaurant_roles ENABLE ROW LEVEL SECURITY;

-- Staff can read roles for restaurants they belong to.
CREATE POLICY "Staff can read restaurant roles"
  ON public.restaurant_roles
  FOR SELECT
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

-- Owner/manager or roles with staff:manage may write (no UI in Phase 2; policy for future use).
CREATE POLICY "Authorized staff can manage restaurant roles"
  ON public.restaurant_roles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = restaurant_roles.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'staff:manage' = ANY (rr.permissions)
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = restaurant_roles.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'staff:manage' = ANY (rr.permissions)
          )
        )
    )
  );
