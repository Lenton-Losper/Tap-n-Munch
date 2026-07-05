-- Phase 5A: dashboard station scoping permissions on restaurant_roles.
-- kitchen: add orders:station:kitchen (orders:read already present).
-- bar: add orders:read + orders:station:bar (bar previously had stock:view only).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:station:kitchen')
WHERE role_slug = 'kitchen'
  AND NOT ('orders:station:kitchen' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:read')
WHERE role_slug = 'bar'
  AND NOT ('orders:read' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:station:bar')
WHERE role_slug = 'bar'
  AND NOT ('orders:station:bar' = ANY(permissions));
