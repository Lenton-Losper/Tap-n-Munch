-- @env: both
--
-- AN ORDER'S ITEMS AND ITS FULFILMENT LINES NEVER DIVERGE (Sprint 2026-09-29, task 5 follow-up).
--
-- Two halves:
--
-- 1. order_is_fully_paid_by_allocations refuses to report "fully paid" when any orders.items entry
--    has no order_lines row. It walked order_lines only, so an item that existed only in the JSON
--    was invisible to it: a split / item settlement could complete an order with that item unpaid.
--    Redefinition: 20260829170000's body verbatim with one guard added at the top; same signature,
--    owner and grants.
--
-- 2. A BEFORE UPDATE trigger refuses any change to items/total on an order that has lines (FTLIN).
--    See the note above the trigger for why this is the generic fix rather than writing lines
--    for guest additions.
--
-- SAFE TO APPLY: one function redefinition, one new trigger; no table change, no data written.
-- Requires nothing from the other 202609291200xx migrations.

CREATE OR REPLACE FUNCTION public.order_is_fully_paid_by_allocations(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line record;
  v_line_total_cents integer;
  v_allocated_cents integer;
  v_settled_cents integer;
  v_any_line boolean := false;
BEGIN
  -- Sprint 2026-09-29 (20260929120400): EVERY ITEM MUST HAVE A LINE. The loop below walks
  -- order_lines, so an orders.items entry with no line was invisible to it and an order could be
  -- reported fully paid while that item was never allocated or paid. Checked first, and against
  -- the items as stored: an order whose items are not a JSON array cannot be proven paid either.
  IF NOT EXISTS (
       SELECT 1 FROM public.orders o
        WHERE o.id = p_order_id AND jsonb_typeof(o.items) = 'array')
     OR EXISTS (
       SELECT 1
         FROM public.orders o,
              jsonb_array_elements(o.items) WITH ORDINALITY AS e(item, ord)
        WHERE o.id = p_order_id
          AND NOT EXISTS (
            SELECT 1 FROM public.order_lines ol
             WHERE ol.order_id = p_order_id
               AND ol.source_item_index = (e.ord - 1)::integer))
  THEN
    RETURN false;
  END IF;

  FOR v_line IN
    SELECT id, source_item_index
    FROM public.order_lines
    WHERE order_id = p_order_id
      AND NOT (
        (kitchen_state IS NULL OR kitchen_state = 'voided')
        AND (bar_state IS NULL OR bar_state = 'voided')
        AND NOT (kitchen_state IS NULL AND bar_state IS NULL)
      )
  LOOP
    v_any_line := true;

    SELECT round((o.items -> v_line.source_item_index ->> 'total')::numeric * 100)::integer
    INTO v_line_total_cents
    FROM public.orders o WHERE o.id = p_order_id;

    IF v_line_total_cents IS NULL THEN
      RETURN false; -- cannot prove it, so it is not proven paid.
    END IF;

    SELECT
      COALESCE(SUM(amount_cents), 0),
      COALESCE(SUM(amount_cents) FILTER (WHERE settled_at IS NOT NULL), 0)
    INTO v_allocated_cents, v_settled_cents
    FROM public.order_line_allocations
    WHERE order_line_id = v_line.id AND voided_at IS NULL;

    -- Not allocated at all: this order is on the whole-order path, not the allocation path.
    IF v_allocated_cents = 0 THEN
      RETURN false;
    END IF;

    -- Allocated but not fully (or the allocations do not sum to the line's own total, or not
    -- every allocated cent is settled yet): not fully paid.
    IF v_allocated_cents <> v_line_total_cents OR v_settled_cents <> v_line_total_cents THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN v_any_line; -- an order with no live lines at all is not "fully paid", it is empty.
END;
$$;

ALTER FUNCTION public.order_is_fully_paid_by_allocations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) TO service_role;

-- ---- an order that has lines never has its items rewritten ------------------------------------
--
-- order_lines.source_item_index indexes into orders.items AS PERSISTED (lib/orders/order-lines.ts).
-- Rewriting items on an order that has lines -- adding an entry, dropping or reordering one --
-- leaves lines pointing at the wrong item and items with no line: food the stations never see,
-- money order_is_fully_paid_by_allocations cannot see. Measured 2026-09-29: the only writer of
-- items/total on an existing order is the guest editor, and every order it can reach (a customer
-- session owns it) has no lines, because lines are written only for terminal rounds and amend
-- replacements, both session-less. This makes that true by construction rather than by
-- coincidence: the change is refused (FTLIN) and the guest editor answers `not_editable_status`.
-- A lined order is changed the way staff change one: amend_order_lines, which voids lines and
-- writes a replacement order with its own lines.
CREATE OR REPLACE FUNCTION public.orders_refuse_items_change_when_lined()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.items IS DISTINCT FROM OLD.items OR NEW.total IS DISTINCT FROM OLD.total)
     AND EXISTS (SELECT 1 FROM public.order_lines WHERE order_id = OLD.id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTLIN',
      MESSAGE = format('order %s has fulfilment lines; its items cannot be rewritten', OLD.id),
      HINT    = 'order_has_lines';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_refuse_items_change_when_lined() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_refuse_items_change_when_lined() FROM PUBLIC;

DROP TRIGGER IF EXISTS orders_items_immutable_when_lined ON public.orders;
CREATE TRIGGER orders_items_immutable_when_lined
  BEFORE UPDATE OF items, total ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refuse_items_change_when_lined();
