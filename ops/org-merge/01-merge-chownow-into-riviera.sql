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
-- TWO BIND POINTS ARE UNFILLED. Do not run this file until both are replaced:
--   :COMPANY_NAME    the surviving organisation's new name
--   :OWNER_USER_ID   the account that holds org-level capability (see step 3 below)
-- Running it as-is is a syntax error, which is the intended failure mode -- a placeholder that
-- silently resolved to something plausible is how the wrong account ends up owning a business.
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
UPDATE public.organizations
   SET name = :'COMPANY_NAME'
 WHERE id = '5608ba8f-54a7-445b-aca5-80593663670c';

-- 4. ORG-LEVEL OWNERSHIP.
--    organization_users is what authorizeOrganization actually reads -- OWNER rows only.
--    organizations.owner_user_id is written at signup and read by NO application code, so it is
--    updated here for provenance only and grants nothing on its own.
--
--    Uncomment ONLY the block matching the ruling.

--  (a) SINGLE OWNER -- the surviving org keeps exactly one OWNER row.
--      Nothing to do beyond the provenance column; Riviera's existing OWNER row already stands.
-- UPDATE public.organizations
--    SET owner_user_id = :'OWNER_USER_ID'
--  WHERE id = '5608ba8f-54a7-445b-aca5-80593663670c';

--  (b) SECOND OWNER -- add the named account alongside the existing one.
--      ON CONFLICT DO NOTHING so a re-run cannot create a duplicate membership.
-- INSERT INTO public.organization_users (organization_id, user_id, role)
-- VALUES ('5608ba8f-54a7-445b-aca5-80593663670c', :'OWNER_USER_ID', 'OWNER')
-- ON CONFLICT DO NOTHING;

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
END $$;

COMMIT;
