-- Issue #336 / #320: `organization_stock_items` has NO unique constraint, and has already
-- produced its first exact duplicate on production.
--
-- MEASURED ON PRODUCTION 2026-08-27 (52 rows, 3 organisations with any canonical items):
--
--   organization                            name       ids                       created_at
--   Lenton Losper's Restaurant (rename me)  Powerade   200758ee-...-9d7367ad1f2c   2026-07-31 05:23:16.721618+00
--                                           Powerade   bb602831-...-77f5c91d942e   2026-08-06 09:16:23.423195+00
--
-- Exactly one duplicate group, under BOTH a case-sensitive `(organization_id, name)` reading
-- and a case-insensitive `(organization_id, lower(trim(name)))` one. Both rows carry the same
-- `base_unit_id` (0172befb-..., "unit") and the same `is_manufactured` (false).
--
-- THAT ORGANISATION HAS ONE LOCATION. This is therefore NOT a merge artefact and not something
-- multi-location work produced: a single venue created the same canonical ingredient twice, six
-- days apart, because nothing stopped it. Any dedupe written on the assumption that the table is
-- clean, or that duplicates only arise from merging organisations, is written against a table
-- that does not exist.
--
-- WHY IT MATTERS BEYOND TIDINESS. The canonical layer's entire job is that two venues point at
-- the SAME row: a transfer needs one `organization_stock_item_id` mapped at both ends. Duplicate
-- canonical rows are how that silently stops working -- #336's Riviera has `coke` while its two
-- sibling venues share `Coke (ChowNow)`, which is the same failure one step further along
-- (different spellings, so no index catches it) and produces four of six transfer pairs at zero
-- transferable items. This index cannot fix `coke` vs `Coke (ChowNow)`. It stops the EXACT and
-- CASE-ONLY repeats, which are the ones a machine can be certain about.
--
-- ============================================================================================
-- THE GROUPING KEY: (organization_id, lower(btrim(name)))
--
-- Case- and whitespace-insensitive, not verbatim. `Powerade` / `powerade` / `Powerade ` are one
-- physical product to the person picking one off a list, and a canonical layer that lets three of
-- them coexist has stopped being canonical. Production is identical under either reading today
-- (one group, the same two rows), so this choice changes WHICH FUTURE ROWS ARE REJECTED, not what
-- this migration merges. If the owner would rather allow case variants, narrow both the temp
-- table's `PARTITION BY` and the index expression to `name` -- nothing else needs to change.
--
-- THE KEEPER: earliest `created_at`, tie-broken by `id` so the choice is total and reproducible.
-- The oldest row is the one existing `stock_items` mappings and any history are most likely to
-- already reference, so it moves the fewest rows.
--
-- WHAT GETS REPOINTED. Exactly the two tables that carry an FK to `organization_stock_items`,
-- confirmed off production's `pg_constraint` rather than assumed:
--   stock_items.organization_stock_item_id           (stock_items_organization_stock_item_id_fkey)
--   stock_transfer_items.organization_stock_item_id  (stock_transfer_items_organization_stock_item_id_fkey)
--
-- ============================================================================================
-- WHY THIS REFUSES RATHER THAN GUESSES, IN TWO CASES
--
-- 1. CONFLICTING UNITS. Two canonical rows with different `base_unit_id` are not the same item
--    expressed twice; merging them would silently reinterpret every quantity recorded against
--    the loser. There is no correct automatic answer, so it raises.
--
-- 2. AN ACTIVE/ACTIVE COLLISION AT ONE VENUE. `stock_items_one_per_org_item_per_restaurant` is
--    UNIQUE (restaurant_id, organization_stock_item_id) WHERE is_active -- so if one venue holds
--    an ACTIVE mapping to the keeper AND an ACTIVE mapping to a loser, repointing violates it.
--    Resolving that means merging two local stock ledgers (`stock_movements` hangs off
--    `stock_items.id`, not off the canonical row), which changes what a venue believes it has on
--    hand. That is an operator's decision, not a migration's, so it raises and names the venue.
--
--    Production does not have this case today: the one duplicate group's two `stock_items` rows
--    are both at Mingle Brew & Pour, and the loser's is `is_active = false`, so the partial index
--    does not cover it and the repoint is clean. The guard exists because that is true of
--    2026-08-27 and of nothing else.
--
-- Both raises abort the whole migration; nothing is half-merged.
--
-- Not CONCURRENTLY: 52 rows, and CREATE INDEX CONCURRENTLY cannot run inside a transaction block.

BEGIN;

-- One computation of the grouping key, reused by every step below AND matched by the index at the
-- bottom. Written once on purpose: a dedupe whose "which rows are duplicates" differs from the
-- index's by so much as a `btrim` deletes rows for nothing and then fails to build.
CREATE TEMP TABLE _osi_dedupe_plan ON COMMIT DROP AS
SELECT
  id                AS loser_id,
  keeper_id,
  organization_id,
  name
FROM (
  SELECT
    id,
    organization_id,
    name,
    first_value(id) OVER w AS keeper_id,
    row_number()    OVER w AS rn
  FROM public.organization_stock_items
  WINDOW w AS (
    PARTITION BY organization_id, lower(btrim(name))
    ORDER BY created_at, id
  )
) ranked
WHERE rn > 1;

DO $$
DECLARE
  v_conflict text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _osi_dedupe_plan) THEN
    RAISE NOTICE 'organization_stock_items: no duplicate (organization_id, lower(btrim(name))) groups; index only';
    RETURN;
  END IF;

  -- (1) Refuse to merge rows that disagree about the unit the quantities are in.
  SELECT string_agg(format('%s (keeper %s, duplicate %s)', p.name, p.keeper_id, p.loser_id), '; ')
    INTO v_conflict
  FROM _osi_dedupe_plan p
  JOIN public.organization_stock_items keeper ON keeper.id = p.keeper_id
  JOIN public.organization_stock_items loser  ON loser.id  = p.loser_id
  WHERE keeper.base_unit_id IS DISTINCT FROM loser.base_unit_id
     OR keeper.is_manufactured IS DISTINCT FROM loser.is_manufactured;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'organization_stock_items dedupe aborted: duplicate canonical items disagree on base_unit_id or is_manufactured, so merging them would reinterpret recorded quantities. Resolve by hand first: %',
      v_conflict;
  END IF;

  -- (2) Refuse where one venue holds an ACTIVE mapping to both the keeper and a duplicate.
  SELECT string_agg(
           format('%s at restaurant %s (keeper %s, duplicate %s)', p.name, loser_si.restaurant_id, p.keeper_id, p.loser_id),
           '; ')
    INTO v_conflict
  FROM _osi_dedupe_plan p
  JOIN public.stock_items loser_si
    ON loser_si.organization_stock_item_id = p.loser_id
   AND loser_si.is_active
  WHERE EXISTS (
    SELECT 1 FROM public.stock_items keeper_si
    WHERE keeper_si.organization_stock_item_id = p.keeper_id
      AND keeper_si.restaurant_id = loser_si.restaurant_id
      AND keeper_si.is_active
  );

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'organization_stock_items dedupe aborted: a location holds an ACTIVE stock_items mapping to both the keeper and its duplicate, so repointing would violate stock_items_one_per_org_item_per_restaurant. Merging those two local ledgers changes what the venue believes it holds and is an operator decision: %',
      v_conflict;
  END IF;
END
$$;

-- Repoint the two FK referents onto the keeper, then drop the now-unreferenced duplicates.
UPDATE public.stock_items si
   SET organization_stock_item_id = p.keeper_id
  FROM _osi_dedupe_plan p
 WHERE si.organization_stock_item_id = p.loser_id;

UPDATE public.stock_transfer_items sti
   SET organization_stock_item_id = p.keeper_id
  FROM _osi_dedupe_plan p
 WHERE sti.organization_stock_item_id = p.loser_id;

DELETE FROM public.organization_stock_items osi
 USING _osi_dedupe_plan p
 WHERE osi.id = p.loser_id;

-- Assert the table is clean BEFORE the index does it, so a failure reads as a sentence rather
-- than as a duplicate-key error naming an index nobody has seen yet.
DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining FROM (
    SELECT 1 FROM public.organization_stock_items
     GROUP BY organization_id, lower(btrim(name))
    HAVING count(*) > 1
  ) still_duplicated;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'organization_stock_items dedupe did not converge: % duplicate (organization_id, lower(btrim(name))) group(s) remain', v_remaining;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS organization_stock_items_organization_id_name_key
  ON public.organization_stock_items (organization_id, lower(btrim(name)));

COMMIT;
