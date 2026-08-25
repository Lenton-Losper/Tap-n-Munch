-- @env: both
--
-- #284 — ANON COULD ENUMERATE EVERY OPEN TAB AT EVERY VENUE.
--
-- The guest policy was:
--
--     CREATE POLICY "Guests can read active tabs for ordering" ON public.tabs
--       FOR SELECT TO anon
--       USING (status IN ('open','ready_to_pay','settled'));
--
-- NO RESTAURANT SCOPE. The anon key ships in every customer's browser, so any holder of it could
-- list every qualifying tab across the whole estate. Measured on production 2026-08-25:
--
--     FNB ChowNow                       19 tabs   value    363.00
--     Riviera                           15 tabs   value   1040.00
--     Digi Cofee                         5 tabs   value     28.00
--     TOTAL visible to any anon key     39 tabs   value   1431.00
--
-- Not a credential leak -- #262 already removed `members` and `tab_pin` from the column grant, and
-- that is confirmed on production. This is cross-tenant disclosure of commercial data: how many
-- tabs each venue has open and what they are worth.
--
-- ============================================================================================
-- WHY THE POLICY COULD NOT SIMPLY BE SCOPED
-- ============================================================================================
--
-- RLS cannot filter this by restaurant, because ANON HAS NO IDENTITY. The QR landing reads a tab
-- before any session token exists; `restaurantId` arrives as a URL parameter, which is a claim by
-- the client and not something the database can verify. A policy that trusted it would be
-- decoration.
--
-- So the fix is the one already applied twice this week: SEND THE ANSWER, NOT THE DATA IT WOULD BE
-- DERIVED FROM. Every customer read of `tabs` now goes through a server route that scopes it with
-- the service role -- GET /api/tabs/active and GET /api/tabs/{id}/view -- and the anon grant is
-- withdrawn entirely.
--
-- ============================================================================================
-- WHAT WAS REMOVED FIRST, so this does not break the landing
-- ============================================================================================
--
--   app/menu/[restaurantId]/v2/page.tsx   re-read `tabs` to confirm a stored tab was still open,
--                                         facts the fetchTabById route had JUST returned. Removed.
--   lib/tab-session.ts                    fetchActiveTabForTable -- NO production callers, only
--                                         tests naming it. Deleted rather than left as a landmine.
--
-- Staff keep their access: "Staff can select tabs for their restaurants" is scoped by
-- user_restaurant_ids() and is untouched. The staff dashboard's realtime `tabs` channel runs
-- authenticated, so it is unaffected -- verified that no anon postgres_changes subscription on
-- `tabs` exists.
--
-- REVERSIBLE. Re-granting is one statement, and it is written out at the bottom for whoever needs
-- it in a hurry.

DROP POLICY IF EXISTS "Guests can read active tabs for ordering" ON public.tabs;

REVOKE SELECT ON TABLE public.tabs FROM anon;

COMMENT ON TABLE public.tabs IS
  'Customer reads go through the server routes (GET /api/tabs/active, GET /api/tabs/{id}/view), '
  'never through the anon key. The anon SELECT grant and its unscoped guest policy were withdrawn '
  'by #284 because the policy had no restaurant scope and allowed cross-tenant enumeration of open '
  'tabs and their values. Do not re-grant without a restaurant predicate the database can verify -- '
  'anon has no identity, so a URL parameter is not one.';

-- ROLLBACK, if the landing breaks and it has to come back right now:
--
--   GRANT SELECT (id, restaurant_id, table_id, table_number, status, settled_type, total,
--                 payment_preference, ready_to_pay_at, pin_required, session_version,
--                 created_at, settled_at, firebase_id, firebase_restaurant_id)
--     ON public.tabs TO anon;
--   CREATE POLICY "Guests can read active tabs for ordering" ON public.tabs
--     FOR SELECT TO anon USING (status IN ('open','ready_to_pay','settled'));
--
-- Note it back to the COLUMN list, never `GRANT SELECT ON public.tabs` -- that would hand back
-- `members` and `tab_pin`, which #262 removed.
