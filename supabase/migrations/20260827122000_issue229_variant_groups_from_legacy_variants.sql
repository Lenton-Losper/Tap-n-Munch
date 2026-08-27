-- #229 -- make `variant_groups` the working mechanism on FNB ChowNow's five drinks.
--
-- WRITTEN, PROVED, NOT APPLIED. This touches live menu data at a trading venue.
--
-- THE DEFECT. Each of these five `menu_items` rows carries TWO shapes at once: the legacy
-- `menu_items.variants` column and a `variant_groups` definition. The menu editor shows the
-- group; `lib/menu/variant-groups.ts#getVariantGroups` drops the group (it carries no `type`)
-- and falls back to the legacy column, so the customer is offered -- and
-- `lib/orders/calculate-order-pricing.ts` charges -- the legacy prices. The venue edits
-- something that does nothing.
--
-- THE RULING (2026-08-27, superseding every earlier one on this issue):
--   1. Variant groups become the working mechanism; the legacy column goes away.
--   2. Option labels are a FREE STRING. No format is imposed.
--   3. Migrate their data AS-IS. Whatever they charge today is what they charge after --
--      INCLUDING Americano's 500ml at N$35, cheaper than its 350ml at N$40. That is their
--      menu, not a defect. Do not correct it.
--   4. Where a group has fewer options than the legacy column, carry across what exists and
--      leave the rest BLANK. Never invent a price.
--
-- WHY THE GROUP'S OWN NUMBERS ARE THROWN AWAY. The two shapes store price differently. Legacy
-- holds an ABSOLUTE per option (`{"size":"S","label":"250ml","price":35}`); the stored groups
-- hold a `price_modifier` DELTA against `base_price`. Those deltas do NOT reproduce the legacy
-- prices -- measured on production 2026-08-27:
--
--   drink            base  legacy charges       stored modifiers imply
--   Americano          35  35 / 40 / 35         +0/+5/+10  -> 35 / 40 / 45   <- 500ml +N$10
--   Cappucinno         45  Large 45 / Small 35  +0/+10/+15 -> 45 / 55 / 60
--   Red Cappuccino     45  35 / 45 / 50         +0/+10/+15 -> 45 / 55 / 60   <- every size moves
--   Flat White         35  35 / 45 / 50         +0/+10/+15 -> 35 / 45 / 50   (agrees)
--   Caffe Latte        35  35 / 45 / 50         +0/+10/+15 -> 35 / 45 / 50   (agrees)
--
-- Three of the five would change price under a naive "activate the groups" migration. So every
-- option below takes its label and its price FROM THE LEGACY COLUMN, and the stored modifiers
-- are discarded. No arithmetic is performed on money anywhere in this file: each `price` below
-- is a value copied out of `variants`, not derived from `base_price` plus anything.
--
-- NO MODIFIER IS STORED, negative or otherwise. `price_modifier` on a variant-group option is
-- read by NO code in this repository -- the canonical option shape every reader consumes is
-- `{label, price}` with an ABSOLUTE price (`lib/menu/variant-groups.ts#normalizeVariantGroups`).
-- Cappucinno's Small at N$35 against a `base_price` of 45 therefore needs no -10 modifier; it
-- is simply stored as 35.
--
-- CAPPUCINNO, per rule 4. Its legacy column holds two options (`Large` 45, `Small` 35) while its
-- stored group holds three (250ml/350ml/500ml). There is no label to match them on and WHICH
-- volume "Large" means is unknowable from the data, so the two that exist carry across verbatim
-- and the third is left BLANK -- `{"label": "", "price": null}` -- for the venue to fill in.
-- `normalizeVariantGroups` discards an option with an empty label, so a blank option is invisible
-- to customers and changes nothing they are offered or charged.
--
-- ORDER IS PRESERVED. Options are written in the legacy column's own order (Cappucinno's is
-- Large-then-Small, not alphabetical) because `getDefaultGroupSelection` preselects `options[0]`.
-- Reordering would change which size is selected when the item opens.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not drop, clear or alter `menu_items.variants`.
-- Retiring that column is a SECOND stage: seven further production rows (five at Mingle Brew &
-- Pour, plus FNB ChowNow "Coke 600ml" and Riviera "Cappucinno") still carry a legacy column with
-- no variant group at all, so dropping it now would blank their options. Keeping it also leaves
-- this migration trivially reversible -- restore `variant_groups` and the fallback resumes.
--
-- PROOF. __tests__/229-migrated-groups-charge-the-same-price.test.ts drives the real
-- `calculateOrderPricing` over every (drink x size) pair that currently holds a price, before and
-- after, with the exact option arrays written below, and asserts the charged cents are equal.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- PRECONDITION. The prices below were copied from production on 2026-08-27. If the venue has
-- edited any of these rows since, the copies are stale and this migration must be re-derived
-- rather than applied -- so refuse instead of overwriting their newer prices with older ones.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  expected CONSTANT jsonb := jsonb_build_object(
    'e0cce45c-1b65-4a1f-8c20-939bbbfe7c31',
      '[{"size":"S","label":"250ml","price":35},{"size":"M","label":"350ml","price":40},{"size":"L","label":"500ml","price":35}]'::jsonb,
    'e184dfe6-a077-4976-b9f3-286fd48d568b',
      '[{"size":"L","label":"Large","price":45},{"size":"S","label":"Small","price":35}]'::jsonb,
    'ad6beab4-8d2e-4244-b0af-3d59e4114cbf',
      '[{"size":"S","label":"250ml","price":35},{"size":"M","label":"350ml","price":45},{"size":"L","label":"500ml","price":50}]'::jsonb,
    'c38b7879-8859-4a65-90ea-322b2465d264',
      '[{"size":"S","label":"250ml","price":35},{"size":"M","label":"350ml","price":45},{"size":"L","label":"500ml","price":50}]'::jsonb,
    '9b366863-b787-4598-bb0d-1a3e95371003',
      '[{"size":"S","label":"250ml","price":35},{"size":"M","label":"350ml","price":45},{"size":"L","label":"500ml","price":50}]'::jsonb
  );
  item_id text;
  actual jsonb;
BEGIN
  FOR item_id IN SELECT jsonb_object_keys(expected) LOOP
    SELECT variants INTO actual FROM menu_items WHERE id = item_id::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION '#229: menu_items row % is gone; re-derive this migration', item_id;
    END IF;
    IF actual IS DISTINCT FROM (expected -> item_id) THEN
      RAISE EXCEPTION
        '#229: menu_items % legacy variants have changed since 2026-08-27. Expected %, found %. Re-derive rather than apply.',
        item_id, expected -> item_id, actual;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- THE CONVERSION. One group per row, keeping the group's stored name ("Size") and its stored
-- `required: true`, gaining the `type: "price"` whose absence is why every reader discarded it,
-- and taking every option label and price from the legacy column.
-- ---------------------------------------------------------------------------------------------

-- Americano -- 250ml N$35, 350ml N$40, 500ml N$35. The 500ml being cheaper than the 350ml is
-- carried across unchanged, per rule 3. It is their menu.
UPDATE menu_items SET variant_groups = '[
  {
    "name": "Size",
    "required": true,
    "type": "price",
    "options": [
      {"label": "250ml", "price": 35},
      {"label": "350ml", "price": 40},
      {"label": "500ml", "price": 35}
    ]
  }
]'::jsonb, updated_at = now()
WHERE id = 'e0cce45c-1b65-4a1f-8c20-939bbbfe7c31';

-- Cappucinno -- Large N$45, Small N$35, in the legacy column's own order, plus ONE BLANK option
-- for the third size the stored group had and the legacy column never priced. Rule 4: carry
-- across what exists, leave the rest blank, guess nothing.
UPDATE menu_items SET variant_groups = '[
  {
    "name": "Size",
    "required": true,
    "type": "price",
    "options": [
      {"label": "Large", "price": 45},
      {"label": "Small", "price": 35},
      {"label": "", "price": null}
    ]
  }
]'::jsonb, updated_at = now()
WHERE id = 'e184dfe6-a077-4976-b9f3-286fd48d568b';

-- Flat White -- 250ml N$35, 350ml N$45, 500ml N$50.
UPDATE menu_items SET variant_groups = '[
  {
    "name": "Size",
    "required": true,
    "type": "price",
    "options": [
      {"label": "250ml", "price": 35},
      {"label": "350ml", "price": 45},
      {"label": "500ml", "price": 50}
    ]
  }
]'::jsonb, updated_at = now()
WHERE id = 'ad6beab4-8d2e-4244-b0af-3d59e4114cbf';

-- Red Cappuccino -- 250ml N$35, 350ml N$45, 500ml N$50. Its `base_price` of 45 is above its
-- cheapest size; left alone, per rule 3. base_price is not charged for any priced selection.
UPDATE menu_items SET variant_groups = '[
  {
    "name": "Size",
    "required": true,
    "type": "price",
    "options": [
      {"label": "250ml", "price": 35},
      {"label": "350ml", "price": 45},
      {"label": "500ml", "price": 50}
    ]
  }
]'::jsonb, updated_at = now()
WHERE id = 'c38b7879-8859-4a65-90ea-322b2465d264';

-- Caffe Latte -- 250ml N$35, 350ml N$45, 500ml N$50.
UPDATE menu_items SET variant_groups = '[
  {
    "name": "Size",
    "required": true,
    "type": "price",
    "options": [
      {"label": "250ml", "price": 35},
      {"label": "350ml", "price": 45},
      {"label": "500ml", "price": 50}
    ]
  }
]'::jsonb, updated_at = now()
WHERE id = '9b366863-b787-4598-bb0d-1a3e95371003';

-- ---------------------------------------------------------------------------------------------
-- POSTCONDITION -- the migration proving itself against the data it just wrote.
--
-- For every one of the five rows: strip the blank placeholders out of the new group and assert
-- that what remains is, in order, exactly the (label, price) pairs of the legacy column. That is
-- the ruling's "no price may change without the venue doing it", checked mechanically rather than
-- asserted, and it fails the transaction if a single figure was mistyped above.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  legacy_pairs jsonb;
  filled_pairs jsonb;
  grp jsonb;
BEGIN
  FOR r IN
    SELECT id, name, variants, variant_groups
    FROM menu_items
    WHERE id IN (
      'e0cce45c-1b65-4a1f-8c20-939bbbfe7c31',
      'e184dfe6-a077-4976-b9f3-286fd48d568b',
      'ad6beab4-8d2e-4244-b0af-3d59e4114cbf',
      'c38b7879-8859-4a65-90ea-322b2465d264',
      '9b366863-b787-4598-bb0d-1a3e95371003'
    )
  LOOP
    IF jsonb_array_length(r.variant_groups) <> 1 THEN
      RAISE EXCEPTION '#229: % should carry exactly one variant group, found %',
        r.name, jsonb_array_length(r.variant_groups);
    END IF;

    grp := r.variant_groups -> 0;

    IF grp ->> 'type' <> 'price' THEN
      RAISE EXCEPTION '#229: % has group type %, so every reader would still discard it',
        r.name, coalesce(grp ->> 'type', '<absent>');
    END IF;
    IF grp ->> 'name' <> 'Size' OR (grp -> 'required')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION '#229: % lost its group name or its required flag', r.name;
    END IF;

    -- The legacy column, as (label, price) in its stored order. This is what customers are
    -- offered and charged TODAY.
    SELECT jsonb_agg(jsonb_build_object('label', v ->> 'label', 'price', (v ->> 'price')::numeric)
                     ORDER BY ord)
      INTO legacy_pairs
      FROM jsonb_array_elements(r.variants) WITH ORDINALITY AS t(v, ord);

    -- The new group's options with blank placeholders removed -- i.e. exactly the options
    -- normalizeVariantGroups() will keep and findSelectedVariantPrice() will price from.
    SELECT coalesce(
             jsonb_agg(jsonb_build_object('label', o ->> 'label', 'price', (o ->> 'price')::numeric)
                       ORDER BY ord),
             '[]'::jsonb)
      INTO filled_pairs
      FROM jsonb_array_elements(grp -> 'options') WITH ORDINALITY AS t(o, ord)
     WHERE coalesce(o ->> 'label', '') <> '';

    IF filled_pairs IS DISTINCT FROM legacy_pairs THEN
      RAISE EXCEPTION
        '#229: % would change price. Legacy column says %, the new group says %.',
        r.name, legacy_pairs, filled_pairs;
    END IF;
  END LOOP;
END $$;

COMMIT;
