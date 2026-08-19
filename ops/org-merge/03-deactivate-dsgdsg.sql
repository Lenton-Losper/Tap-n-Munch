-- DEACTIVATE THE "dsgdsg" TEST ITEM. Ruled: deactivate, do NOT delete.
--
-- SEPARATE FROM THE MERGE, and run after it. Nothing here depends on the merge and the merge does
-- not depend on this; keeping them apart means a problem with one cannot roll back the other.
--
-- WHY NOT A DELETE. Measured before ruling: the item has been USED --
--   stock_movements       1 row  (quantity_delta +2, reason "received")
--   goods_received_items  1 row  (quantity 2, goods_received a9b832ea-87ad-433a-a035-b3baf0ba6da2)
-- Every FK into stock_items is ON DELETE RESTRICT, so a DELETE would FAIL rather than cascade.
-- Making it succeed would mean first deleting a goods-received line and a stock movement, which is
-- erasing an inventory record -- a materially different act from clearing a stray row. The
-- goods-received history stays.
--
-- is_active = false IS THE PATH THE SCHEMA INTENDS. stock_items carries the column, and the unique
-- index stock_items_one_per_org_item_per_restaurant is deliberately partial on it -- deactivating
-- also frees the (restaurant_id, organization_stock_item_id) slot, so a real item could later take
-- its place. It hides the row from the stock screens and the transfer picker while the receipt
-- history behind it stays readable.
--
-- THE CATALOGUE ROW IS LEFT ALONE. organization_stock_items has no is_active column, and the local
-- stock_items row is what every screen actually lists. Deleting the catalogue row would fail anyway
-- while the local row still references it.
--
-- ROLLBACK:
--   UPDATE public.stock_items SET is_active = true
--    WHERE id = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2';

BEGIN;

UPDATE public.stock_items
   SET is_active = false
 WHERE id = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2'
   AND restaurant_id = '01bf27f1-a958-4322-bb3e-cc5240987808'
   AND name = 'dsgdsg'
   AND is_active = true;   -- refuses a re-run, and refuses if it is not the row expected

DO $$
DECLARE
    v_off      int;
    v_history  int;
BEGIN
    SELECT count(*) INTO v_off
      FROM public.stock_items
     WHERE id = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2'
       AND is_active = false;
    IF v_off <> 1 THEN
        RAISE EXCEPTION 'dsgdsg was not deactivated -- expected 1 inactive row, found %', v_off;
    END IF;

    -- The point of choosing deactivation over deletion: the history must still be there.
    -- Asserted rather than assumed, because "we kept the history" is the whole justification.
    SELECT (SELECT count(*) FROM public.stock_movements      WHERE stock_item_id = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2')
         + (SELECT count(*) FROM public.goods_received_items WHERE stock_item_id = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2')
      INTO v_history;
    IF v_history <> 2 THEN
        RAISE EXCEPTION 'goods-received history changed: expected 2 rows, found %', v_history;
    END IF;
END $$;

COMMIT;
