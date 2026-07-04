-- Analytics permission: grant analytics:view to owner/manager restaurant_roles only.

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'analytics:view')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('analytics:view' = ANY(permissions));
