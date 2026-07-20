-- Retire the legacy users.restaurant_id column (Workstream 1: multi-location tenancy
-- foundation). It has coexisted with the proper restaurant_users join table since the
-- baseline schema, is unconstrained (no FK, no trigger keeps it in sync), and the current
-- signup path (create_restaurant_for_user, since 2026-07-09) never sets it -- every account
-- created since then already has restaurant_id = NULL. All application code that read or
-- wrote it has been moved onto restaurant_users / getRestaurantIdForUser() in the same
-- change as this migration.
--
-- Two RLS policies still referenced it directly and must be repointed (or dropped) before
-- the column can go, since Postgres tracks policy-on-column dependencies same as views:
--   1. "Users can read own restaurant" (restaurants, SELECT) -- redundant: a second,
--      independently-permissive "Public can read restaurants" policy (USING (true)) already
--      makes this table world-readable, so this one is dead weight, not a live gate. Dropped.
--   2. bug_reports_insert_own_restaurant / bug_reports_select_own_restaurant -- NOT dead:
--      because users.restaurant_id has been NULL for every account created since
--      2026-07-09, "Report a Bug" (components/bug-report-button.tsx) has been silently
--      RLS-denied for all such accounts already, independent of this migration. Repointed to
--      the same user_restaurant_ids() helper every other restaurant-scoped table's RLS uses,
--      which both unblocks this column drop and fixes that live bug.

DROP POLICY IF EXISTS "Users can read own restaurant" ON public.restaurants;

DROP POLICY IF EXISTS "bug_reports_insert_own_restaurant" ON public.bug_reports;
CREATE POLICY "bug_reports_insert_own_restaurant"
  ON public.bug_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (restaurant_id IN (SELECT public.user_restaurant_ids()));

DROP POLICY IF EXISTS "bug_reports_select_own_restaurant" ON public.bug_reports;
CREATE POLICY "bug_reports_select_own_restaurant"
  ON public.bug_reports
  FOR SELECT
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

ALTER TABLE public.users
  DROP COLUMN IF EXISTS restaurant_id;
