-- @env: both
--
-- ONE FULFILMENT LINE PER ORDERED ITEM, ENFORCED (Sprint 2026-09-30, RC-ORDERS A4).
--
-- order_lines.source_item_index is "the join back to money, one-to-one: one item, one line, one
-- index" (20260827131000) -- and nothing enforced it. POST /api/terminal/rounds decides whether a
-- send is a replay by asking "do lines already exist for this order?", then writes them. Two sends
-- of ONE idempotency key arriving together (a double tap, or a retry fired while the first is still
-- in flight) both get the same order -- one creates it, the other gets it back from createOrder's
-- 23505 branch -- and both read "no lines yet" before either has written. Both then wrote the whole
-- round: every item twice on one order, the kitchen making it twice, the bill counting it once.
-- Reproduced through the real route, PostgREST and Postgres (chaos scenario orders-cancel-kitchen,
-- O04): responses duplicate=[false,false], 4 lines for a 2-item round.
--
-- With this index the second insert fails as a unit (one INSERT statement carries the whole round)
-- and the route answers it as the replay it is.
--
-- The only other writer, amend_order_lines, inserts replacement lines into a NEW order with fresh,
-- distinct indexes, so it cannot collide.
--
-- SAFE TO APPLY: additive (one unique index, no data written). It REFUSES, with a count, if a
-- duplicate already exists -- that would be a round the kitchen was sent twice, which needs a human
-- decision (void the copy through the terminal), not a silent delete here.

DO $$
DECLARE
  v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes
  FROM (
    SELECT 1 FROM public.order_lines GROUP BY order_id, source_item_index HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'order_lines has % (order_id, source_item_index) pair(s) written more than once; '
      'resolve them (SELECT order_id, source_item_index, array_agg(id) FROM order_lines GROUP BY 1, 2 '
      'HAVING count(*) > 1) before applying 20260930100000', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS order_lines_one_line_per_item
  ON public.order_lines (order_id, source_item_index);

COMMENT ON INDEX public.order_lines_one_line_per_item IS
  'One fulfilment line per orders.items entry. A double-tapped Send used to write the round twice (20260930100000).';
