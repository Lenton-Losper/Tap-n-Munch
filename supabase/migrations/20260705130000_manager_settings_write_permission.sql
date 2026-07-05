-- Manager settings:write — restores assertRestaurantAdmin-equivalent access for setup-status and settings mutations.

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'settings:write')
WHERE role_slug = 'manager'
  AND NOT ('settings:write' = ANY(permissions));
