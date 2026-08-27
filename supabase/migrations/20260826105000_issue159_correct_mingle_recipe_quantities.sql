-- #159 (F1) — nine Mingle recipe quantities were entered as stock counts, not per-serving amounts.
--
-- !! NOT APPLIED. NEEDS THE OWNER'S SIGN-OFF BEFORE IT RUNS. !!
-- Mingle is live and trading. This changes recipe data at a venue taking money, and it was
-- written from a read-only audit on 2026-08-26 without any production write being made.
--
-- WHAT WAS MEASURED
--
-- On all nine rows below the recipe quantity is EXACTLY the quantity that was received into
-- stock for that same item. That is not a coincidence at n=9; it is a delivery count typed into
-- a field that means "amount consumed per single unit sold":
--
--   stock item          received            recipe quantity
--   Wedge biscuits      30 on 2026-08-06    30
--   Powerade            24 on 2026-08-06    24
--   Sausage roll        20 on 2026-08-06    20
--   popcorn             20 on 2026-08-06    20
--   Mckane dry lemon    12 on 2026-08-06    12
--   Mckane Lemonade     12 on 2026-08-06    12
--   Mckane soda water   12 on 2026-08-06    12
--   Mckane tonic water  12 on 2026-08-06    12
--   Single brownie      10 on 2026-08-05    10
--
-- Three of them then self-destructed in the ledger, a single sale consuming the whole delivery:
-- Wedge biscuits `received:30` then `sale:-30`; Powerade `received:24` then `sale:-24`;
-- Mckane Lemonade `received:12` then `sale:-12`. Each was followed by a manual recount, and
-- `menu_items.track_inventory` is now false on all nine — switching tracking off is how the
-- merchant stopped the bleeding.
--
-- WHY IT IS SAFE, AND WHY IT IS STILL URGENT
--
-- Safe: all nine sit on untracked menu items, so neither deduct_recipe_stock nor
-- check_stock_sufficiency_locked reads them today. Correcting them changes no live behaviour
-- and moves no balance.
--
-- Urgent: they are the reason tracking cannot be turned back on. Re-enabling any one of them
-- uncorrected re-breaks it on the first or second sale — Wedge biscuits would go from 12 to -18
-- on a single order.
--
-- WHY 1 IS THE RIGHT VALUE
--
-- Every one of the nine is a single-ingredient recipe whose one ingredient is the item being
-- sold, counted in units of that same item: menu "Popcorn" consumes stock "popcorn". Selling one
-- can only consume one.
--
-- Deliberately NOT corrected here:
--   - FNB ChowNow "Chicken Wings" at 5. Received 50, three sales of -5, balance 35 and never
--     negative. Five wings to a portion; that is a correct recipe and must not be touched.
--   - Digi Cofee's 30 g / 0.3 L / 0.05 kg amounts. Genuine per-serving quantities.
--   - Mingle "Powerade" is included below even though its balance was later recounted to 100,
--     because its quantity still equals its delivery.

BEGIN;

-- Guarded three ways, so this cannot clobber a correction someone else makes first, and cannot
-- touch a recipe that has since gained a second ingredient:
--   1. scoped to Mingle by id;
--   2. the quantity must STILL be the exact miskeyed value measured on 2026-08-26;
--   3. the recipe must still have exactly one ingredient.
-- Re-running it after it has been applied updates nothing.
WITH target AS (
    SELECT ri.id
      FROM public.recipe_items ri
      JOIN public.recipes rc ON rc.id = ri.recipe_id
      JOIN public.stock_items si ON si.id = ri.stock_item_id
     WHERE rc.restaurant_id = '131c39d1-b816-407d-8c5f-e628fc38967e'
       AND (si.name, ri.quantity) IN (
             ('Wedge biscuits',     30),
             ('Powerade',           24),
             ('Sausage roll',       20),
             ('popcorn',            20),
             ('Mckane dry lemon',   12),
             ('Mckane Lemonade',    12),
             ('Mckane soda water',  12),
             ('Mckane tonic water', 12),
             ('Single brownie',     10)
           )
       AND (SELECT count(*) FROM public.recipe_items x WHERE x.recipe_id = rc.id) = 1
)
UPDATE public.recipe_items ri
   SET quantity = 1
  FROM target
 WHERE ri.id = target.id;

-- Refuses to commit if this did not land on exactly the nine rows the audit measured. If the
-- data has moved on, that is a reason to re-measure, not to apply a stale correction.
DO $$
DECLARE
    v_remaining integer;
BEGIN
    SELECT count(*)
      INTO v_remaining
      FROM public.recipe_items ri
      JOIN public.recipes rc ON rc.id = ri.recipe_id
      JOIN public.stock_items si ON si.id = ri.stock_item_id
     WHERE rc.restaurant_id = '131c39d1-b816-407d-8c5f-e628fc38967e'
       AND si.name IN ('Wedge biscuits','Powerade','Sausage roll','popcorn','Mckane dry lemon',
                       'Mckane Lemonade','Mckane soda water','Mckane tonic water','Single brownie')
       AND ri.quantity <> 1;

    IF v_remaining <> 0 THEN
        RAISE EXCEPTION
          '#159: % of the nine Mingle recipe quantities are still not 1 — re-measure before applying',
          v_remaining;
    END IF;
END $$;

COMMIT;

-- NOT DONE HERE, ON PURPOSE:
--   - track_inventory is NOT switched back on for these nine. That is the merchant's decision,
--     and it should follow a stock count, not a migration.
--   - No stock_movements row is written. These recipes have not deducted since being untracked,
--     so there is nothing to compensate. The historic oversells (Croissant -80, Still water -80,
--     Koeksister -60, Cappy juice -43) were already resolved by manual recounts; no stock item
--     at any venue carries a negative balance as of 2026-08-26.
