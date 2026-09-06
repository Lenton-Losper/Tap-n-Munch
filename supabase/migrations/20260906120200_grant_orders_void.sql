-- @env: both
--
-- Grant orders:void to every existing manager and owner role row.
--
-- ============================================================================================
-- WHY A DATA MIGRATION AND NOT JUST THE CONFIG FILE
-- ============================================================================================
--
-- lib/permissions/role-permissions.config.json defines what a NEWLY SEEDED venue gets. It does
-- nothing for venues that already exist: restaurant_roles is a per-venue table, seeded once at
-- creation and thereafter edited on the staff page. Without this, authorize() would refuse
-- orders:void for EVERYONE -- owners included -- and the void control would be dead on arrival.
--
-- The same lesson as 20260904030000 (tabs:close_unpaid), which found 67 role rows across all
-- venues and 0 carrying the new permission immediately after it was added in TypeScript.
--
-- MANAGER AND OWNER ONLY. Not cashier and not waiter: the waiter who took the order is the one
-- with a reason to remove it, and a control they can sign off themselves is not a control.
--
-- ============================================================================================
-- IDEMPOTENT, AND IT TOUCHES NOTHING ELSE
-- ============================================================================================
--
-- The WHERE clause excludes rows that already carry it, so re-running changes nothing --
-- array_append alone would duplicate, and the containment test is what makes it safe.
--
-- It APPENDS one element rather than rewriting the array, so a venue that has customised its
-- manager role on the staff page keeps every customisation.
--
-- NO SCHEMA CHANGE HERE, deliberately: the CHECK rewrite and the void_reason column are their
-- own migrations. A migration that bundles a schema fix with a data write to live rows should
-- not exist (ruled 2026-09-02, enforced by scripts/check-migration-no-data-write.mjs).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'orders:void')
WHERE role_slug IN ('manager', 'owner')
  AND NOT (permissions @> ARRAY['orders:void']::text[]);
