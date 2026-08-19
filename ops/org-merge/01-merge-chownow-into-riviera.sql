-- ORGANISATION MERGE: FNB ChowNow's organisation into Riviera's. Production data change.
--
-- NOT A MIGRATION, and deliberately not in supabase/migrations/. This is a one-off data change to
-- two specific rows-sets on one database; it describes no schema and must never be replayed onto
-- staging or a fresh environment. It is applied with `db query -f`, with NO `migration repair`
-- afterwards, so the ledger is untouched.
--
-- WHY ONE TRANSACTION. The cross-organisation invariant -- a stock_item's catalogue item must
-- belong to the same organisation as the stock_item's restaurant -- is enforced by a trigger on
-- STOCK_ITEMS (BEFORE INSERT OR UPDATE OF organization_stock_item_id, restaurant_id). Neither
-- statement below touches stock_items, so NOTHING RE-VALIDATES: the database will not stop us
-- getting this wrong. Moving the restaurant without its catalogue would leave 8 links pointing at
-- another organisation's rows, and the next edit to any of them would fail on a trigger for data
-- that was already there. One transaction means no window in which that state is observable.
--
-- BEFORE-VALUES: ops/org-merge/snapshot-2026-08-19-before.txt, captured read-only immediately
-- before this ran, with paste-ready rollback statements generated from the measured values.
--
-- =====================================================================================
-- VALUES FILLED IN 2026-08-19 from the ruling. No placeholders remain.
--   company name : Gosto Investment CC
--   ownership    : flashtapapp2@gmail.com (f9bf5348-1c1c-4574-8830-13b249722097), UNCHANGED --
--                  it is already both organizations.owner_user_id and the sole OWNER row on the
--                  surviving organisation, so the ruling "keep it" means NO ownership statement
--                  runs at all. See section 4.
--
-- PREREQUISITE: 00-rename-chownow-coke.sql must have run first. This file does not check names,
-- and the assertion that would have caught a collision lives there, where it is still cheap to fix.
-- =====================================================================================

BEGIN;

-- 1. THE RESTAURANT MOVES.
--    FNB ChowNow leaves org 1d623c21 (FNB ChowNow) and joins org 5608ba8f (Riviera).
UPDATE public.restaurants
   SET organization_id = '5608ba8f-54a7-445b-aca5-80593663670c'
 WHERE id = 'b161c758-582d-4dfa-839a-9fa35c492a49'
   AND organization_id = '1d623c21-8c5e-40fd-b7bc-df654166d412';  -- refuses a re-run / a moved target

-- 2. ITS CATALOGUE MOVES WITH IT, in the same transaction.
--    All 8 rows, addressed by the organisation they are leaving rather than by a hand-typed id
--    list, so a row added between the snapshot and this statement cannot be silently left behind.
UPDATE public.organization_stock_items
   SET organization_id = '5608ba8f-54a7-445b-aca5-80593663670c'
 WHERE organization_id = '1d623c21-8c5e-40fd-b7bc-df654166d412';

-- 3. THE SURVIVING ORGANISATION IS RENAMED to the company, not the site.
--    "Riviera" is a site name; it is about to front two-to-three of them.
UPDATE public.organizations
   SET name = 'Gosto Investment CC'
 WHERE id = '5608ba8f-54a7-445b-aca5-80593663670c'
   AND name = 'Riviera';  -- refuses if it has already been renamed by something else

-- 4. ORG-LEVEL OWNERSHIP: NO STATEMENT, BY RULING.
--
--    flashtapapp2@gmail.com is f9bf5348-1c1c-4574-8830-13b249722097, and is ALREADY both
--    organizations.owner_user_id and the single OWNER row in organization_users on the surviving
--    organisation. "Keep it, no change to ownership" therefore executes nothing -- the correct
--    implementation of that ruling is an absence, not an idempotent self-assignment, which would
--    only add a write that could go wrong.
--
--    THE CONSEQUENCE, RESTATED SO IT IS NOT A SURPRISE LATER: flashtaptestacc1@gmail.com's OWNER
--    row belongs to the organisation being left behind, so after this it holds no org-level
--    capability -- no Add Location, no view-all-locations. Its `owner` row in restaurant_users for
--    FNB ChowNow is untouched, so its day-to-day access to that restaurant is entirely unchanged.
--    Section 5 explains why that row is left in place rather than tidied away.

-- 5. THE EMPTIED ORGANISATION IS LEFT IN PLACE, deliberately.
--    Deleting it would CASCADE to its organization_users row, silently revoking
--    flashtaptestacc1@gmail.com's org-level capability as a side effect of tidying up. An empty
--    organisation costs nothing and is visible to no one; deletion is a separate ruling.
--    DO NOT add `DELETE FROM public.organizations WHERE id = '1d623c21-...'` to this file.

-- ---------------------------------------------------------------------------------------
-- IN-TRANSACTION ASSERTIONS. If any fails the whole transaction rolls back, so a wrong result
-- is never committed and then reported afterwards.
-- ---------------------------------------------------------------------------------------
DO $$
DECLARE
    v_rest_in_org   int;
    v_orphan_links  int;
    v_left_behind   int;
    v_named         int;
    v_owners        int;
    v_staff         int;
BEGIN
    SELECT count(*) INTO v_rest_in_org
      FROM public.restaurants
     WHERE organization_id = '5608ba8f-54a7-445b-aca5-80593663670c';
    IF v_rest_in_org <> 2 THEN
        RAISE EXCEPTION 'expected 2 restaurants in the surviving organisation, found %', v_rest_in_org;
    END IF;

    -- The invariant the trigger would enforce, checked explicitly because nothing here fires it.
    SELECT count(*) INTO v_orphan_links
      FROM public.stock_items si
      JOIN public.restaurants r  ON r.id = si.restaurant_id
      JOIN public.organization_stock_items osi ON osi.id = si.organization_stock_item_id
     WHERE si.organization_stock_item_id IS NOT NULL
       AND r.organization_id <> osi.organization_id;
    IF v_orphan_links <> 0 THEN
        RAISE EXCEPTION 'cross-organisation stock_items links after merge: %', v_orphan_links;
    END IF;

    SELECT count(*) INTO v_left_behind
      FROM public.organization_stock_items
     WHERE organization_id = '1d623c21-8c5e-40fd-b7bc-df654166d412';
    IF v_left_behind <> 0 THEN
        RAISE EXCEPTION 'catalogue rows left behind in the emptied organisation: %', v_left_behind;
    END IF;

    -- The rename actually applied. Guarded above with AND name = 'Riviera', so a no-op would
    -- otherwise pass silently and the organisation would still be called after one of its sites.
    SELECT count(*) INTO v_named
      FROM public.organizations
     WHERE id = '5608ba8f-54a7-445b-aca5-80593663670c'
       AND name = 'Gosto Investment CC';
    IF v_named <> 1 THEN
        RAISE EXCEPTION 'surviving organisation is not named "Gosto Investment CC" after the rename';
    END IF;

    -- OWNERSHIP UNCHANGED. Nothing above touches organization_users, so this asserts an absence:
    -- exactly the one OWNER row that was there before, still there, still that account.
    SELECT count(*) INTO v_owners
      FROM public.organization_users
     WHERE organization_id = '5608ba8f-54a7-445b-aca5-80593663670c';
    IF v_owners <> 1 THEN
        RAISE EXCEPTION 'expected the surviving organisation to still have exactly 1 member, found %', v_owners;
    END IF;

    -- STAFF ACCESS UNCHANGED. The four rows measured in the snapshot, across both restaurants.
    -- This is the assertion that matters most to the people actually working tomorrow.
    SELECT count(*) INTO v_staff
      FROM public.restaurant_users
     WHERE restaurant_id IN ('b161c758-582d-4dfa-839a-9fa35c492a49',
                             '01bf27f1-a958-4322-bb3e-cc5240987808')
       AND deleted_at IS NULL;
    IF v_staff <> 4 THEN
        RAISE EXCEPTION 'restaurant_users changed: expected 4 live rows across both restaurants, found %', v_staff;
    END IF;
END $$;

COMMIT;
