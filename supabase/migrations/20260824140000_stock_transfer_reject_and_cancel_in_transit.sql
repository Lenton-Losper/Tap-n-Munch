-- @env: both
--
-- #335 — A DISPATCHED TRANSFER COULD NEVER BE UNDONE, AND THE STOCK EXISTED NOWHERE.
--
-- Stock is deducted at dispatch (`transfer_out`) and added at receive (`transfer_in`), so between
-- the two it is at NO location. That is a fair model for goods in a van. What was not fair is that
-- the only way out of that window was forward: `cancel_transfer` accepted DRAFT only, and there was
-- no reject at all, so the destination's sole power was refusal-by-inaction — which does not return
-- the stock, it strands it.
--
-- Worse, `receive_transfer` RAISES if the destination's canonical-item mapping disappeared while the
-- goods were in transit ('defect: ... was confirmed to exist at dispatch'). At that point receive is
-- impossible and cancel is refused, so the transfer sits IN_TRANSIT forever and the deducted stock
-- is gone from the books with no recovery short of a hand-written stock_movements insert. The
-- author saw the window — the exception text says so — what was missing is the remedy.
--
-- This adds both exits, and both put the stock back where it came from.
--
-- SAFE TO BUILD PROPERLY: measured 2026-08-24, this flow has NEVER run in production — zero
-- stock_transfers, zero stock_transfer_items, zero transfer_out/transfer_in movements. There is no
-- live data to migrate or protect.
--
-- Forward-only and additive: two widened CHECK constraints, three new nullable columns, one new
-- function, and one replaced function that only GAINS a branch.

-- ---------------------------------------------------------------- vocabulary

ALTER TABLE "public"."stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_status_check";
ALTER TABLE "public"."stock_transfers" ADD CONSTRAINT "stock_transfers_status_check"
  CHECK ("status" IN ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED', 'REJECTED'));

-- `transfer_return` rather than reusing `transfer_in`. A return to source and a receipt at the
-- destination are different events, and conflating them makes "where did this stock go" unanswerable
-- later from the ledger alone -- which is the whole reason the movement rows exist.
ALTER TABLE "public"."stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_reason_check";
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_reason_check"
  CHECK ("reason" = ANY (ARRAY[
    'received'::text, 'adjustment'::text, 'loss'::text, 'theft'::text, 'recount'::text,
    'sale'::text, 'transfer_out'::text, 'transfer_in'::text, 'transfer_return'::text
  ]));

ALTER TABLE "public"."stock_transfers"
  ADD COLUMN IF NOT EXISTS "rejected_by" uuid REFERENCES "public"."users"("id"),
  ADD COLUMN IF NOT EXISTS "rejected_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "rejection_reason" text;

-- ---------------------------------------------------------------- shared return

CREATE OR REPLACE FUNCTION "public"."return_transfer_stock_to_source"(p_transfer_id uuid, p_user_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer public.stock_transfers%ROWTYPE;
    v_item     RECORD;
    v_source_stock_item_id uuid;
BEGIN
    SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id;

    FOR v_item IN
        SELECT * FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id
    LOOP
        -- The SOURCE mapping, not the destination's. A return goes back where the stock left from,
        -- and the source mapping is guaranteed to have existed because dispatch verified it before
        -- deducting. If it has since been deactivated we still put the stock back: refusing here
        -- would recreate the exact strand this migration exists to remove.
        SELECT id INTO v_source_stock_item_id
        FROM public.stock_items
        WHERE restaurant_id = v_transfer.from_restaurant_id
          AND organization_stock_item_id = v_item.organization_stock_item_id
        ORDER BY is_active DESC
        LIMIT 1;

        IF v_source_stock_item_id IS NULL THEN
            RAISE EXCEPTION
              'cannot return organization_stock_item % to restaurant %: no stock_items row at all. The stock is stranded and needs a manual movement.',
              v_item.organization_stock_item_id, v_transfer.from_restaurant_id;
        END IF;

        -- Same shape as the dispatch and receive inserts: reference_type/reference_id link the
        -- movement to the transfer, so the ledger reads out/return as one story rather than an
        -- unexplained credit appearing at the source.
        INSERT INTO public.stock_movements (
            restaurant_id, stock_item_id, quantity_delta, reason,
            reference_type, reference_id, created_by, created_at, notes
        ) VALUES (
            v_transfer.from_restaurant_id, v_source_stock_item_id, v_item.quantity_sent,
            'transfer_return',
            'stock_transfer', p_transfer_id, p_user_id, now(), p_reason
        );
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "public"."return_transfer_stock_to_source"(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."return_transfer_stock_to_source"(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."return_transfer_stock_to_source"(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------- reject

CREATE OR REPLACE FUNCTION "public"."reject_transfer"(p_transfer_id uuid, p_user_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer public.stock_transfers%ROWTYPE;
BEGIN
    SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transfer % not found', p_transfer_id;
    END IF;

    -- Only a transfer actually in the van can be rejected. A DRAFT is cancelled, not rejected, and
    -- a RECEIVED one is already booked in -- reversing that is a new transfer, not a rejection.
    IF v_transfer.status <> 'IN_TRANSIT' THEN
        RAISE EXCEPTION 'transfer % can only be rejected while IN_TRANSIT (status=%)', p_transfer_id, v_transfer.status;
    END IF;

    PERFORM public.return_transfer_stock_to_source(p_transfer_id, p_user_id, 'rejected');

    UPDATE public.stock_transfers
       SET status = 'REJECTED',
           rejected_by = p_user_id,
           rejected_at = now(),
           rejection_reason = p_reason
     WHERE id = p_transfer_id;
END;
$$;

REVOKE ALL ON FUNCTION "public"."reject_transfer"(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reject_transfer"(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."reject_transfer"(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------- cancel, now including IN_TRANSIT

CREATE OR REPLACE FUNCTION "public"."cancel_transfer"(p_transfer_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_transfer public.stock_transfers%ROWTYPE;
BEGIN
    SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transfer % not found', p_transfer_id;
    END IF;

    IF v_transfer.status = 'CANCELLED' THEN
        RETURN;
    END IF;

    -- DRAFT: no stock has moved, so this stays a pure status change.
    -- IN_TRANSIT: stock WAS deducted at dispatch and must come back. This is the branch #335 added;
    --   without it the sender could not recall their own goods.
    IF v_transfer.status = 'IN_TRANSIT' THEN
        PERFORM public.return_transfer_stock_to_source(p_transfer_id, p_user_id, 'cancelled in transit');
    ELSIF v_transfer.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'transfer % cannot be cancelled from status % (only DRAFT or IN_TRANSIT)', p_transfer_id, v_transfer.status;
    END IF;

    UPDATE public.stock_transfers SET status = 'CANCELLED' WHERE id = p_transfer_id;
END;
$$;

REVOKE ALL ON FUNCTION "public"."cancel_transfer"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."cancel_transfer"(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."cancel_transfer"(uuid, uuid) TO service_role;
