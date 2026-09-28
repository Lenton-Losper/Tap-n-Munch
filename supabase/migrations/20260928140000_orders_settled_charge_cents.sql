-- @env: both
--
-- orders.settled_charge_cents: WHAT A WHOLE-ORDER SETTLEMENT ACTUALLY APPLIED TO THIS ORDER.
--
-- ADDITIVE. One nullable column, one CHECK, one BEFORE UPDATE trigger. No function is redefined,
-- no row is rewritten, and nothing reads the column until the application code that selects it is
-- deployed -- which must come AFTER this is applied (PostgREST refuses a select naming an absent
-- column, and lib/orders/order-financials.ts fails closed on that refusal).
--
-- ================================================================================================
-- WHY
-- ================================================================================================
--
-- `amend_order_lines` never rewrites an order, so `orders.total` keeps counting voided lines. The
-- financial projection (lib/orders/order-financials.ts) derives what is live; to say what was PAID
-- for a paid order it needs the cents the settlement actually applied to it. Nothing recorded that:
-- settle_order_payment clears pending_charge_cents on the paid transition (F18), and the other
-- writers never had it. So the projection had to assume `paid = total`, which is right for every
-- order paid before voids existed and wrong -- in the customer's favour or against it -- for every
-- amended one.
--
-- NULL means "not recorded" and the projection treats it as the legacy basis (paid = total), which
-- is what every gate charged before this. It is never back-filled: the true figure for an old order
-- is not recoverable from anything stored.
--
-- ================================================================================================
-- THE MECHANISM: CAPTURE THE RECORDED ATTEMPT AT THE MOMENT IT LANDS
-- ================================================================================================
--
-- `pending_charge_cents` is what the reader was asked for, per order, written by prepare-payment
-- BEFORE the charge -- and it is exactly the figure every gateway gate verified (the settle RPC's
-- expectation, expectedChargeFor in verify-payment / the webhook / reconcile / the device callback).
-- So on the transition INTO paid, this trigger copies OLD.pending_charge_cents less the gratuity
-- riding on it into settled_charge_cents. A trigger rather than an edit to each writer because there
-- are ten paid-writers, several of them direct `.update({ payment_status: 'paid' })` calls, and one
-- place is the only version that cannot miss one.
--
-- EXPLICIT WINS. A statement that sets settled_charge_cents itself (the cash/tab settle route, the
-- item-ledger routes that flip an order paid with a whole-order charge of zero) keeps its value: the
-- trigger only fills the column when the statement left it unchanged. Those writers know the figure
-- better than a possibly-stale card attempt does.
--
-- WHICH WRITERS ARE COVERED (paid transitions, 2026-09-28):
--   settle_order_payment RPC (webhook, verify-payment)      trigger, from pending_charge_cents
--   markOrderPaidConfirmed (device callback, stale-POS cron,
--     held-for-review clear, failure correction, orphan
--     reconcile)                                             trigger, from pending_charge_cents
--   app/api/payments/reconcile, reconcile-orphan bulk path   trigger, from pending_charge_cents
--   terminal tabs/[tabId]/settle (cash, card, PayToday)       explicit, per order, after the claim
--   settle-allocations route, settleAllocationsForIntent     explicit 0 (whole-order charge is 0)
-- A path that recorded no attempt leaves NULL: it charged the order total, which is the legacy basis.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS settled_charge_cents integer;

-- Named and added separately: an inline CHECK on ADD COLUMN IF NOT EXISTS is silently dropped when
-- the column already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_settled_charge_cents_non_negative'
       AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_settled_charge_cents_non_negative
      CHECK (settled_charge_cents IS NULL OR settled_charge_cents >= 0);
  END IF;
END;
$$;

COMMENT ON COLUMN public.orders.settled_charge_cents IS
  'Cents a WHOLE-ORDER settlement applied to this order, gratuity excluded. Captured on the '
  'transition to paid from pending_charge_cents (trigger orders_record_settled_charge) unless the '
  'writer set it explicitly. NULL = not recorded (legacy: the order total was charged). '
  'Item-ledger settlements are NOT included; they live in order_line_allocation_settlements.';

CREATE OR REPLACE FUNCTION public.orders_record_settled_charge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    -- Explicit wins: the statement set the column itself.
    IF NEW.settled_charge_cents IS NOT DISTINCT FROM OLD.settled_charge_cents THEN
      IF OLD.pending_charge_cents IS NOT NULL AND OLD.pending_charge_cents > 0 THEN
        NEW.settled_charge_cents :=
          GREATEST(0, OLD.pending_charge_cents - COALESCE(OLD.pending_tip_cents, 0));
      ELSE
        -- No attempt was recorded, so the gate compared against the order total: legacy basis.
        NEW.settled_charge_cents := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_record_settled_charge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_record_settled_charge() FROM PUBLIC;

DROP TRIGGER IF EXISTS orders_record_settled_charge ON public.orders;
CREATE TRIGGER orders_record_settled_charge
  BEFORE UPDATE OF payment_status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_record_settled_charge();
