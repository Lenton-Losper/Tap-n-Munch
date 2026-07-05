-- Payments cluster permissions: owner restaurant_roles only (payments:view + payments:configure).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'payments:view')
WHERE role_slug = 'owner'
  AND NOT ('payments:view' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'payments:configure')
WHERE role_slug = 'owner'
  AND NOT ('payments:configure' = ANY(permissions));
