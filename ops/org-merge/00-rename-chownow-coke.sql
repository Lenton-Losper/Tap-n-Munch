-- STEP 0, RUN BEFORE THE MERGE: disambiguate the colliding catalogue name.
--
-- Both organisations hold an item called "coke", and they are NOT the same item -- different
-- base_unit_id. organization_stock_items has no unique index on (organization_id, name), so merging
-- them would not fail; it would silently produce two identically-named rows in one catalogue and
-- leave staff choosing between them in the transfer picker.
--
-- Ruled: rename ChowNow's to "Coke (ChowNow)" BEFORE the merge.
--
-- SEPARATE FROM THE MERGE TRANSACTION, deliberately. It is independent and self-contained: if the
-- merge is later abandoned, this rename is harmless on its own and reverts with one statement.
-- Doing it first also means the merge transaction never has to reason about names at all.
--
-- Renaming the CATALOGUE row only. `stock_items.name` is the restaurant's own local label for its
-- copy and is a different column on a different row -- the local item stays "coke", which is what
-- ChowNow's staff already see on their own stock screens. Nothing about their day changes.
--
-- ROLLBACK:
--   UPDATE public.organization_stock_items
--      SET name = 'coke'
--    WHERE id = '760b6027-7084-4cc8-b565-be8940c13072';

BEGIN;

UPDATE public.organization_stock_items
   SET name = 'Coke (ChowNow)'
 WHERE id = '760b6027-7084-4cc8-b565-be8940c13072'
   AND organization_id = '1d623c21-8c5e-40fd-b7bc-df654166d412'  -- still un-merged; refuses a re-run
   AND name = 'coke';                                            -- refuses if already renamed

DO $$
DECLARE
    v_renamed int;
    v_clash   int;
BEGIN
    SELECT count(*) INTO v_renamed
      FROM public.organization_stock_items
     WHERE id = '760b6027-7084-4cc8-b565-be8940c13072'
       AND name = 'Coke (ChowNow)';
    IF v_renamed <> 1 THEN
        RAISE EXCEPTION 'rename did not apply -- expected 1 row named "Coke (ChowNow)", found %', v_renamed;
    END IF;

    -- The point of the exercise: after the merge there must be no duplicate name across the two
    -- catalogues. Checked here, while it is still cheap to fix.
    SELECT count(*) INTO v_clash
      FROM public.organization_stock_items a
      JOIN public.organization_stock_items b
        ON lower(btrim(a.name)) = lower(btrim(b.name))
       AND a.id <> b.id
     WHERE a.organization_id = '1d623c21-8c5e-40fd-b7bc-df654166d412'
       AND b.organization_id = '5608ba8f-54a7-445b-aca5-80593663670c';
    IF v_clash <> 0 THEN
        RAISE EXCEPTION 'still % colliding name(s) between the two catalogues -- do not merge', v_clash;
    END IF;
END $$;

COMMIT;
