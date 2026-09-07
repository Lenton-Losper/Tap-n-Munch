-- @env: both
--
-- THE GRATUITY BELONGS ON THE INTENT, because the intent is what the reader was asked for.
--
-- ================================================================================================
-- WHY
-- ================================================================================================
--
-- `terminal_payment_intents.amount_cents` is a single number: what WiseCashier is told to charge.
-- It is also the figure checkSaleAmount reconciles a gateway echo against -- basis 'intent', NOT
-- advisory, at GATEWAY_AMOUNT_TOLERANCE_CENTS of zero.
--
-- So a tip has to be INSIDE amount_cents before the charge. But once it is, the row can no longer
-- say how much of the charge was the bill and how much was the gratuity -- and the two settle to
-- different places. The allocations settle at their own amounts into
-- order_line_allocation_settlements; the gratuity is written to payment_tips, attributed to a named
-- member of staff.
--
-- These two columns are what lets the settlement, which happens AFTER the charge and possibly in a
-- webhook the device never sees, split the one number back into its parts. Without them the tip is
-- knowable only to the device that asked for it, and a webhook-settled split payment would record
-- the whole charge as items and lose the gratuity.
--
-- ================================================================================================
-- WHAT WENT WRONG WITHOUT IT
-- ================================================================================================
--
-- Every processPaymentIntent call site charged bill-only amounts. The tip was collected in the UI,
-- sent at settle time, and recorded in payment_tips as though taken -- while the customer's card
-- was charged the bill alone. A silent under-charge with the ledger disagreeing with the money.
-- Found 2026-09-09; payment_tips had 0 rows on production, so nothing had reconciled either way.
--
-- ================================================================================================
-- A TIP IS NOT REVENUE
-- ================================================================================================
--
-- Owner's ruling, 2026-09-05: settler-attributed, not revenue, its own table, and never inside an
-- order total. Nothing here changes that. amount_cents is what the CARD was charged, which is a
-- different question from what the restaurant earned; the allocations still settle at their own
-- amounts and the order totals are untouched.
--
-- tip_staff_user_id is NOT an FK to users(id) on purpose -- it mirrors payment_tips.staff_user_id,
-- which is verified against restaurant_users membership at write time, because an FK alone would
-- happily accept a real user from another venue.

ALTER TABLE public.terminal_payment_intents
  ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_staff_user_id uuid;

-- A negative gratuity is a refund, which this path cannot express. And a tip cannot exceed the
-- charge it rode in on.
ALTER TABLE public.terminal_payment_intents
  DROP CONSTRAINT IF EXISTS terminal_payment_intents_tip_sane;

ALTER TABLE public.terminal_payment_intents
  ADD CONSTRAINT terminal_payment_intents_tip_sane
  CHECK (tip_cents >= 0 AND tip_cents < amount_cents);

-- A gratuity with nobody to pay it to is not recordable: payment_tips.staff_user_id is NOT NULL,
-- so an intent carrying a tip and no recipient would settle and then fail to record the tip, AFTER
-- the card had been charged.
ALTER TABLE public.terminal_payment_intents
  DROP CONSTRAINT IF EXISTS terminal_payment_intents_tip_needs_staff;

ALTER TABLE public.terminal_payment_intents
  ADD CONSTRAINT terminal_payment_intents_tip_needs_staff
  CHECK (tip_cents = 0 OR tip_staff_user_id IS NOT NULL);

COMMENT ON COLUMN public.terminal_payment_intents.tip_cents IS
  'How much of amount_cents is a gratuity. amount_cents is what the READER was asked to charge -- '
  'items plus tip -- because that single figure is what a gateway echo is reconciled against. This '
  'is what lets the settlement split it back: allocations settle at their own amounts, the tip goes '
  'to payment_tips. Zero for a charge with no gratuity.';

COMMENT ON COLUMN public.terminal_payment_intents.tip_staff_user_id IS
  'users.id the gratuity is attributed to, verified against restaurant_users membership before the '
  'intent is created. Deliberately not an FK: an FK would accept a real user from another venue.';
