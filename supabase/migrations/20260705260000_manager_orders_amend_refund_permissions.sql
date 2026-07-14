-- Manager: grant orders:amend + orders:refund additively (text[] permissions column).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:amend')
WHERE role_slug = 'manager'
  AND NOT ('orders:amend' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:refund')
WHERE role_slug = 'manager'
  AND NOT ('orders:refund' = ANY(permissions));
