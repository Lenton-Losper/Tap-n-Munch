-- Workstream 4 (1/3): grant stock:transfer_create/dispatch/receive to existing owner/manager
-- restaurant_roles rows. Editing role-permissions.config.json alone only affects the static
-- fallback and new-restaurant seeding (create_restaurant_for_user) -- existing restaurant_roles
-- rows are the primary source for authorize() and are not retroactively updated by the JSON
-- change, so they need the same additive backfill pattern already used for orders:amend/
-- orders:refund (20260705260000_manager_orders_amend_refund_permissions.sql).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'stock:transfer_create')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('stock:transfer_create' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'stock:transfer_dispatch')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('stock:transfer_dispatch' = ANY(permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'stock:transfer_receive')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('stock:transfer_receive' = ANY(permissions));
