-- Grant tabs:close_unpaid to every existing manager and owner role row.
--
-- ============================================================================================
-- WHY A DATA MIGRATION AND NOT JUST THE CONFIG FILE
-- ============================================================================================
--
-- lib/permissions/role-permissions.config.json defines what a NEWLY SEEDED venue gets. It does
-- nothing for venues that already exist: restaurant_roles is a per-venue table, seeded once at
-- creation, and thereafter edited on the staff page.
--
-- Measured on production 2026-09-04, immediately after adding the permission in TypeScript:
--
--     ALL VENUES: 67 role rows, 0 carrying tabs:close_unpaid
--
-- So authorize() would have refused a walkout for EVERYONE, owners included. Safe, but the feature
-- would have been dead on arrival, and the moment anyone discovered it is a customer walking out
-- with the room watching. That is the worst possible time to find out a permission was never
-- granted.
--
-- ============================================================================================
-- ONLY manager AND owner, AND ONLY WHERE IT IS MISSING
-- ============================================================================================
--
-- Matching the owner's ruling exactly: manager and owner, no cashier. Waiters must not hold it --
-- gating a walkout on a permission the waiter has would let the person being walked out on sign
-- off the loss.
--
-- restaurant_roles.permissions is text[], NOT jsonb -- established by reading the live column
-- type after a jsonb containment operator errored against it. The two are interchangeable to a
-- reader and not to Postgres.
--
-- The WHERE clause excludes rows that already carry it, so this is idempotent and re-running
-- changes nothing. array_append alone would duplicate; the containment test is what makes it safe.
--
-- IT DOES NOT TOUCH ANY OTHER PERMISSION. The update appends one element to the existing array
-- rather than rewriting it, so a venue that has customised its manager role on the staff page
-- keeps every customisation.

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'tabs:close_unpaid')
WHERE role_slug IN ('manager', 'owner')
  AND NOT (permissions @> ARRAY['tabs:close_unpaid']::text[]);

COMMENT ON TABLE public.restaurant_roles IS
  'Per-venue role -> permission grants, seeded from lib/permissions/role-permissions.config.json at venue creation and editable on the staff page. ADDING A PERMISSION TO THAT CONFIG DOES NOT REACH EXISTING VENUES -- it needs a data migration like 20260904030000, or authorize() refuses the new capability for everyone including owners.';
