-- @env: both
--
-- A CARD CHARGE MUST CHARGE AND SETTLE AGAINST THE SAME VERSION OF THE ORDER (Sprint 2026-09-29
-- brief, task 5: guest edit during a card charge).
--
-- ================================================================================================
-- THE DEFECT
-- ================================================================================================
--
-- prepare-payment computes each order's outstanding figure, writes it to pending_charge_cents, and
-- the device charges that figure. payment_status stays 'pending' while the customer taps, and the
-- guest order editor allows 'pending' -- so a guest could add items WHILE THE CARD WAS BEING
-- CHARGED. Nothing cleared pending_charge_cents, settle_order_payment summed the stale
-- pending_charge_cents, agreed with the gateway, and marked the order paid. The receipt then showed
-- the new total: the added items were recorded as paid for at the old figure.
--
-- The mirror image comes from the staff side. amend_order_lines voids a line mid-charge; the card
-- is charged the prepared (higher) figure; the settlement agrees with it and the order is paid at
-- MORE than its live value. The stale-intent check (M5, `target_changed_since_preparation`) does
-- NOT see either case: it compares the caller's expectation with pending_charge_cents, and neither
-- a guest edit nor a void touches pending_charge_cents.
--
-- ================================================================================================
-- THE MECHANISM: A BASIS STAMPED WITH THE CHARGE
-- ================================================================================================
--
-- `order_charge_basis(order)` is a fingerprint of everything the charged figure is derived from:
--   * orders.total (in integer cents, so 260 and 260.00 agree),
--   * orders.items (jsonb text is canonical),
--   * the set of VOIDED order_lines (VOIDED_LINE: every owning station 'voided' -- the rule in
--     lib/orders/order-financials.ts; a kitchen moving a line to cooked/ready does NOT change it),
--   * the set of item-ledger settlements against the order (what is already paid).
-- It is a change detector, not a price: no money formula is re-derived here (contract C1).
--
-- Whenever pending_charge_cents is written, a trigger stamps `pending_charge_basis` (and
-- `pending_charge_at`) from the row as it stands at that moment. A writer that computed its figure
-- from an EARLIER read may also hand over the basis it read in `pending_charge_read_basis`; if the
-- order has moved since, the write raises SQLSTATE FTCHG instead of recording a stale figure
-- (prepare-payment does this -- its read of the order and its write of the expectation are two
-- round trips apart).
--
-- ================================================================================================
-- THREE GUARDS, AND WHY ALL THREE
-- ================================================================================================
--
-- (A) PRIMARY -- refuse the edit while a charge is in flight. `orders_refuse_edit_during_charge`
--     raises FTINF when total/items change on an order carrying a prepared charge that is less than
--     PAYMENT_IN_FLIGHT_WINDOW (5 minutes) old. Only the guest editor rewrites total/items on an
--     existing order (measured: no other writer in app/ or lib/ updates either column), so this is
--     the guest edit lock, enforced by the database rather than by a read in a Worker. The route
--     maps FTINF to its existing `payment_in_flight` refusal. amend_order_lines refuses
--     `payment_in_flight` on the same window (20260929120200).
--     WHY PRIMARY: by the time any settlement-time check fires, the card has been debited. Refusing
--     the edit costs the customer a retry after paying; refusing the settlement costs a refund.
--
-- (B) BACKSTOP IN THE RPC -- settle_order_payment holds the set (`amount_mismatch_hold`, audited)
--     when any owing order's current basis differs from the stamped one (20260929120100). This is
--     what catches an edit after the window expired (a device that never reported back), and
--     anything (A) does not see.
--
-- (C) BACKSTOP FOR EVERY OTHER PAID-WRITER -- `orders_refuse_paid_on_changed_charge` raises FTCHG
--     when an order moves to 'paid' by a non-cash method while its stamped basis no longer matches.
--     markOrderPaidConfirmed (device callback, verify-before-cancel, auto-cancel cron, reconcile)
--     catches FTCHG and holds + records. Exempt, because none of them consumes the prepared card
--     charge: cash and PayToday (counted against the live figure the waiter is shown -- an abandoned
--     card attempt must never make a table impossible to settle another way); a writer that states
--     settled_charge_cents in the same statement (the dashboard's Mark-as-Paid, which computes it
--     from the live figure); and held -> paid (a human resolving a hold, which this trigger must not
--     make unresolvable).
--
-- SAFE TO APPLY: additive. Three nullable columns, two functions, three triggers, and a backfill
-- that stamps the basis on orders already carrying a prepared charge (so a charge in flight at
-- deploy time is guarded too). No existing value is changed. Apply BEFORE deploying code that
-- selects `pending_charge_at` / `charge_basis` (PostgREST 42703 otherwise).

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pending_charge_basis text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pending_charge_at timestamptz;
-- Write-only: consumed and nulled by the stamp trigger, never at rest non-null.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pending_charge_read_basis text;

COMMENT ON COLUMN public.orders.pending_charge_basis IS
  'order_charge_basis() at the moment pending_charge_cents was written. A settlement refuses/holds when the order no longer matches it (20260929120000).';
COMMENT ON COLUMN public.orders.pending_charge_at IS
  'When pending_charge_cents was last written. A charge younger than 5 minutes is in flight: guest edits and staff voids are refused.';
COMMENT ON COLUMN public.orders.pending_charge_read_basis IS
  'Write-only. The basis the writer computed its figure from; the stamp trigger raises FTCHG if the order has moved since, then nulls it.';

/**
 * VOLATILE, deliberately. Called from a BEFORE trigger on a row this statement waited to lock: a
 * STABLE function would read order_lines through the statement's ORIGINAL snapshot and miss a void
 * committed while it waited -- the exact change it exists to see. VOLATILE takes a fresh snapshot
 * per query under READ COMMITTED.
 */
CREATE OR REPLACE FUNCTION public.order_charge_basis(p_order_id uuid, p_total numeric, p_items jsonb)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT md5(
       COALESCE(round(p_total * 100)::bigint::text, '-')
    || '|' || COALESCE(p_items::text, '-')
    || '|' || COALESCE((
         SELECT string_agg(ol.id::text, ',' ORDER BY ol.id)
           FROM public.order_lines ol
          WHERE ol.order_id = p_order_id
            AND (ol.kitchen_state IS NOT NULL OR ol.bar_state IS NOT NULL)
            AND COALESCE(ol.kitchen_state, 'voided') = 'voided'
            AND COALESCE(ol.bar_state, 'voided') = 'voided'), '')
    || '|' || COALESCE((
         SELECT string_agg(s.id::text, ',' ORDER BY s.id)
           FROM public.order_line_allocations a
           JOIN public.order_line_allocation_settlements s ON s.order_line_allocation_id = a.id
          WHERE a.order_id = p_order_id), ''))
$$;

ALTER FUNCTION public.order_charge_basis(uuid, numeric, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_charge_basis(uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_charge_basis(uuid, numeric, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_charge_basis(uuid, numeric, jsonb) TO service_role;

/**
 * The same fingerprint as a PostgREST COMPUTED FIELD, so prepare-payment can read it in the same
 * select as the order: `.select('..., charge_basis')`.
 */
CREATE OR REPLACE FUNCTION public.charge_basis(o public.orders)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.order_charge_basis(o.id, o.total, o.items)
$$;

ALTER FUNCTION public.charge_basis(public.orders) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.charge_basis(public.orders) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.charge_basis(public.orders) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.charge_basis(public.orders) TO service_role;

-- ---- the stamp ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orders_stamp_pending_charge_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current text;
BEGIN
  IF NEW.pending_charge_cents IS NULL THEN
    -- The attempt is over (settled, released, or cancelled). Nothing is in flight.
    NEW.pending_charge_basis      := NULL;
    NEW.pending_charge_at         := NULL;
    NEW.pending_charge_read_basis := NULL;
    RETURN NEW;
  END IF;

  v_current := public.order_charge_basis(NEW.id, NEW.total, NEW.items);

  -- THE WRITER'S READ IS STALE. Its figure was computed from an order that has since changed, so
  -- recording it would launch the reader for the wrong amount. Nothing has been charged yet.
  IF NEW.pending_charge_read_basis IS NOT NULL AND NEW.pending_charge_read_basis <> v_current THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTCHG',
      MESSAGE = format('order %s changed after its charge was computed', NEW.id),
      HINT    = 'order_changed_since_read';
  END IF;

  NEW.pending_charge_basis      := v_current;
  NEW.pending_charge_at         := now();
  NEW.pending_charge_read_basis := NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_stamp_pending_charge_basis() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_stamp_pending_charge_basis() FROM PUBLIC;

-- `UPDATE OF pending_charge_cents` fires whenever the column is in the SET list, even with an
-- unchanged value: a re-preparation after an equal-price swap writes the same cents and must still
-- re-stamp, or its own settlement would be held.
DROP TRIGGER IF EXISTS orders_charge_basis_stamp ON public.orders;
CREATE TRIGGER orders_charge_basis_stamp
  BEFORE INSERT OR UPDATE OF pending_charge_cents, pending_charge_read_basis ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_stamp_pending_charge_basis();

-- ---- (A) no content change while a charge is in flight ------------------------------------------
CREATE OR REPLACE FUNCTION public.orders_refuse_edit_during_charge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.total IS DISTINCT FROM OLD.total OR NEW.items IS DISTINCT FROM OLD.items)
     AND OLD.pending_charge_cents IS NOT NULL
     -- A statement that restates the charge WITH the content is a re-preparation, and the stamp
     -- trigger re-bases it; no application writer does this, the stale-intent test does.
     AND NEW.pending_charge_cents IS NOT DISTINCT FROM OLD.pending_charge_cents
     -- FAILS CLOSED on a missing timestamp: the backfill below stamps every prepared row.
     AND (OLD.pending_charge_at IS NULL OR OLD.pending_charge_at > now() - interval '5 minutes')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTINF',
      MESSAGE = format('order %s has a card charge in flight; it cannot be changed now', OLD.id),
      HINT    = 'payment_in_flight';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_refuse_edit_during_charge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_refuse_edit_during_charge() FROM PUBLIC;

DROP TRIGGER IF EXISTS orders_charge_in_flight_guard ON public.orders;
CREATE TRIGGER orders_charge_in_flight_guard
  BEFORE UPDATE OF total, items ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refuse_edit_during_charge();

-- ---- (C) never paid by card against a basis that no longer holds --------------------------------
CREATE OR REPLACE FUNCTION public.orders_refuse_paid_on_changed_charge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(btrim(COALESCE(NEW.payment_status, ''))) = 'paid'
     AND lower(btrim(COALESCE(OLD.payment_status, ''))) NOT IN
           ('paid', 'amount_mismatch_hold', 'verification_unavailable_hold')
     -- NOT A GATEWAY CHARGE, so there is no prepared figure it could be stale against. Cash and
     -- PayToday are counted by a person against the live figure on screen.
     AND lower(btrim(COALESCE(NEW.payment_method, ''))) NOT IN ('cash', 'paytoday')
     -- A writer that states what it collected (settled_charge_cents, in the SAME statement) computed
     -- it from the order as it stands: the dashboard's Mark-as-Paid (record_manual_order_payment,
     -- f-manual 20260929100000), including a standalone card machine. It is not consuming the
     -- prepared charge. Gateway writers never do this: settle_order_payment, markOrderPaidConfirmed
     -- and the tab-settle card claim leave it to orders_record_settled_charge (which fires AFTER this
     -- trigger, alphabetically) or write it in a later statement.
     AND NEW.settled_charge_cents IS NOT DISTINCT FROM OLD.settled_charge_cents
     AND OLD.pending_charge_basis IS NOT NULL
     AND OLD.pending_charge_basis <> public.order_charge_basis(OLD.id, OLD.total, OLD.items)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTCHG',
      MESSAGE = format('order %s changed after its card charge was prepared; not marking it paid', OLD.id),
      HINT    = 'order_changed_since_charge_prepared';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_refuse_paid_on_changed_charge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_refuse_paid_on_changed_charge() FROM PUBLIC;

DROP TRIGGER IF EXISTS orders_charge_basis_paid_guard ON public.orders;
CREATE TRIGGER orders_charge_basis_paid_guard
  BEFORE UPDATE OF payment_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refuse_paid_on_changed_charge();

-- ---- backfill: a charge prepared before this migration is guarded from now on -------------------
-- Restating the column fires the stamp trigger, which is the single place the basis is computed.
UPDATE public.orders
   SET pending_charge_cents = pending_charge_cents
 WHERE pending_charge_cents IS NOT NULL
   AND pending_charge_basis IS NULL
   AND payment_status IN ('unpaid', 'pending', 'terminal_pending', 'cash_pending', 'failed');
