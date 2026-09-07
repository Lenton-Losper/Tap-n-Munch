-- @env: both
--
-- WHAT THE READER WAS ASKED FOR, ON A WHOLE-ORDER CARD CHARGE.
--
-- ================================================================================================
-- THE INVARIANT THIS RESTORES
-- ================================================================================================
--
-- THE AMOUNT SENT TO THE GATEWAY MUST BE THE AMOUNT VERIFICATION COMPARES AGAINST. The split path
-- already holds to that: terminal_payment_intents.amount_cents is both what the reader is told to
-- charge and what checkSaleAmount reconciles the gateway's echo against, at zero tolerance.
--
-- The whole-order path had no such record. Three gates independently recomputed `order.total`:
--
--   app/api/terminal/orders/[orderId]/verify-payment/route.ts:252
--   app/api/webhooks/paycloud/route.ts:167
--   app/api/payments/reconcile/route.ts:88
--
-- So the moment a gratuity is added to the charge, all three refuse a payment that succeeded --
-- AFTER the customer's card has been debited. That is why the tip was never added to the charge at
-- all, and why the tip was instead recorded as collected while the customer paid only the bill.
--
-- These columns are the whole-order equivalent of the intent row: written BEFORE the reader is
-- launched, read by every gate afterwards.
--
-- ================================================================================================
-- WHY NOT A TOLERANCE
-- ================================================================================================
--
-- A "tip tolerance" would mean accepting any amount within some band of the order total, which
-- turns a byte-exact correlation check into a fuzzy one on the money path. GATEWAY_AMOUNT_TOLERANCE
-- is ZERO precisely because Finatic is echoing back OUR OWN figure -- a cent of daylight means the
-- reference correlated to a different sale. Widening it would trade a real integrity check for a
-- feature. The fix is to make our own figure correct, not to stop checking it.
--
-- ================================================================================================
-- IT IS A PENDING ATTEMPT, NOT AN ACCOUNTING FACT
-- ================================================================================================
--
-- `pending_charge_cents` describes an ATTEMPT: what we asked for on the charge currently in flight.
-- It is not revenue, not a total, and nothing may sum it. The order's own total is untouched, and
-- the gratuity still settles to payment_tips -- a tip is not revenue and never enters an order
-- total (owner's ruling 2026-09-05).
--
-- NULL means "no attempt has recorded an expectation", and every gate falls back to the order total
-- for exactly that case -- which is every order that predates this migration, and every path that
-- does not prepare a charge. That fallback is what makes this safe to deploy ahead of any caller.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pending_charge_cents integer,
  ADD COLUMN IF NOT EXISTS pending_tip_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_tip_staff_user_id uuid;

-- A negative gratuity is a refund, which this path cannot express; a tip cannot exceed the charge
-- it rode in on; and a charge of nothing is not a charge.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_pending_charge_sane;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_pending_charge_sane
  CHECK (
    (pending_charge_cents IS NULL OR pending_charge_cents > 0)
    AND pending_tip_cents >= 0
    AND (pending_charge_cents IS NULL OR pending_tip_cents < pending_charge_cents)
  );

-- payment_tips.staff_user_id is NOT NULL, so a pending gratuity with nobody to pay it to would
-- settle and then fail to record the tip AFTER the card had been charged.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_pending_tip_needs_staff;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_pending_tip_needs_staff
  CHECK (pending_tip_cents = 0 OR pending_tip_staff_user_id IS NOT NULL);

COMMENT ON COLUMN public.orders.pending_charge_cents IS
  'What the reader was asked to charge on the current attempt: order total plus any gratuity, in '
  'integer cents. The figure every gateway-amount check compares against, so that the amount sent '
  'and the amount verified are the same number. NULL = no attempt recorded one; gates then fall '
  'back to the order total. An ATTEMPT, not an accounting fact -- never sum it.';

COMMENT ON COLUMN public.orders.pending_tip_cents IS
  'How much of pending_charge_cents is a gratuity, so the settlement can split the single charged '
  'figure back into revenue and tip. The tip settles to payment_tips and never enters the order '
  'total.';
