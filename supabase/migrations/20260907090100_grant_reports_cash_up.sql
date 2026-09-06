-- @env: both
--
-- Grant `reports:cash_up` to the manager and owner roles.
--
-- ============================================================================================
-- WHY THIS IS NEEDED AT ALL
-- ============================================================================================
--
-- lib/permissions/role-permissions.config.json is the STATIC FALLBACK, and authorize() reaches it
-- only when a restaurant has no restaurant_roles row. Every live venue has one, so a permission
-- added to that file alone reaches NEWLY SEEDED venues and nobody else. Without this, a manager
-- at Riviera types a correct PIN and is told they cannot authorise a cash-up, because the
-- permission the purpose maps to is not in their row.
--
-- IDEMPOTENT: the containment test skips rows that already carry it, so re-running changes
-- nothing and cannot duplicate the entry.
--
-- IT TOUCHES NOTHING ELSE: array_append adds one element and leaves every other permission in
-- place, so a venue that has customised its roles on the staff page keeps every customisation.
--
-- MANAGER AND OWNER ONLY. Not cashier, not waiter. The document is the day's takings, printed
-- from a device that sits on a counter all evening.
--
-- NO SCHEMA CHANGE HERE. This is a data write to live rows and nothing else, which is the only
-- shape it is allowed to have (ruled 2026-09-02).

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'reports:cash_up')
WHERE role_slug IN ('manager', 'owner')
  AND NOT (permissions @> ARRAY['reports:cash_up']::text[]);
