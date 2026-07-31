-- Serialise the out-of-stock check for a given set of stock items.
--
-- The TypeScript check (lib/orders/check-stock-sufficiency.ts) issues four separate queries:
-- menu_items, recipes, recipe_items, then stock_movements. Nothing holds them together, so
-- concurrent orders can interleave and read a torn view of the ledger.
--
-- This does the whole thing in one transaction and takes a row-level lock on the relevant
-- stock_items rows first: SELECT ... FOR UPDATE. Rows are locked in id order, the same
-- deadlock-avoidance reasoning deduct_recipe_stock and dispatch_transfer already use when
-- taking their advisory locks. Any other caller of this function for an overlapping stock
-- item waits rather than racing.
--
-- Balance is summed from stock_movements because there is no stored balance column -- so the
-- lock target is the stock_items row that owns the ledger entries, which is the conventional
-- way to guard a derived aggregate.
--
-- HONEST LIMIT, measured rather than assumed (see
-- scripts/stock-verify-oversell-race-20260801.ts): this makes the CHECK atomic. It does not
-- make check-and-create atomic, because the order is inserted by application code after this
-- returns and the lock is released at commit. Two callers can therefore still both observe a
-- positive balance for the last unit and both proceed -- nothing decrements between them.
-- Closing that fully requires the insert to happen inside this transaction; see
-- docs/followup-oversell-race-on-last-item.md.
CREATE OR REPLACE FUNCTION "public"."check_stock_sufficiency_locked"(
    "p_restaurant_id" uuid,
    "p_menu_item_ids" uuid[]
)
RETURNS TABLE (
    menu_item_id uuid,
    menu_item_name text,
    stock_item_id uuid,
    stock_item_name text,
    balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stock_ids uuid[];
BEGIN
    -- Every stock item reachable from the tracked menu items in this order.
    SELECT array_agg(DISTINCT ri.stock_item_id ORDER BY ri.stock_item_id)
      INTO v_stock_ids
      FROM recipes r
      JOIN menu_items m
        ON m.id = r.menu_item_id
       AND m.restaurant_id = r.restaurant_id
      JOIN recipe_items ri
        ON ri.recipe_id = r.id
     WHERE r.restaurant_id = p_restaurant_id
       AND r.menu_item_id = ANY(p_menu_item_ids)
       AND r.is_active = true
       AND m.track_inventory IS TRUE;

    IF v_stock_ids IS NULL OR array_length(v_stock_ids, 1) IS NULL THEN
        RETURN; -- nothing tracked in this order
    END IF;

    -- Take the row locks in a deterministic order before reading any balances.
    PERFORM 1
       FROM stock_items si
      WHERE si.id = ANY(v_stock_ids)
      ORDER BY si.id
        FOR UPDATE;

    RETURN QUERY
    SELECT m.id,
           m.name,
           si.id,
           si.name,
           COALESCE(bal.total, 0)
      FROM recipes r
      JOIN menu_items m
        ON m.id = r.menu_item_id
       AND m.restaurant_id = r.restaurant_id
      JOIN recipe_items ri
        ON ri.recipe_id = r.id
      JOIN stock_items si
        ON si.id = ri.stock_item_id
      LEFT JOIN LATERAL (
           SELECT SUM(sm.quantity_delta) AS total
             FROM stock_movements sm
            WHERE sm.stock_item_id = ri.stock_item_id
      ) bal ON true
     WHERE r.restaurant_id = p_restaurant_id
       AND r.menu_item_id = ANY(p_menu_item_ids)
       AND r.is_active = true
       AND m.track_inventory IS TRUE
       AND COALESCE(bal.total, 0) <= 0;
END;
$$;

-- Called from server routes running as service_role. Not reachable with the anon key: this
-- project's default privileges grant EXECUTE on new public functions to anon/authenticated at
-- CREATE time, which has already proved exploitable once (see 20260727130000).
REVOKE ALL ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."check_stock_sufficiency_locked"(uuid, uuid[]) TO service_role;
