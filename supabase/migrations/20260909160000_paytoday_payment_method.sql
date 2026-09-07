-- @env: both
--
-- PAYTODAY AS A THIRD SETTLEMENT METHOD. v1: whole-order only, no tips, no kiosk, no QR.
--
-- ================================================================================================
-- WHAT PAYTODAY IS, AND WHAT IT IS NOT
-- ================================================================================================
--
-- A Nedbank product the waiter transacts in THEMSELVES, outside FlashTap. They take the payment in
-- PayToday's own app, then pick PayToday on the terminal, confirm the amount, and mark it paid.
--
-- THERE IS NO API CALL. No reader, no gateway, no webhook, no intent, no credential, no merchant
-- identifier. Verified 2026-09-09 across both repositories, both env files, the Android libs and
-- the migration set: nothing PayToday-shaped exists anywhere, and under this design nothing needs
-- to. FlashTap records an ASSERTION, exactly as it does for cash.
--
-- SO FLASHTAP HAS NO PROOF A PAYTODAY PAYMENT ARRIVED. None. The venue reconciles against Nedbank's
-- own statement, and nothing on our side can contradict it. That is weaker than cash, not equal to
-- it: cash is countable in a drawer at close of day, while this is a waiter's word about a third
-- party's app with no artefact we can query. Nothing downstream may imply otherwise.
--
-- IT COUNTS AS REVENUE, like cash. Owner's ruling 2026-09-09.
--
-- ================================================================================================
-- WHY 'paytoday' AND NOT 'mobile_money'
-- ================================================================================================
--
-- `mobile_money` is already permitted by the settings CHECK and would have needed no migration at
-- all. It is still the wrong choice, and deliberately rejected (owner's ruling, 2026-09-09): it
-- names a CATEGORY, so a second mobile product at another venue would be indistinguishable from
-- this one in every report, receipt and cash-up, with no way to separate them afterwards. A
-- reconciliation against Nedbank's statement needs to name Nedbank's product.
--
-- ================================================================================================
-- WHAT IS DELIBERATELY *NOT* WIDENED
-- ================================================================================================
--
-- order_line_allocation_settlements.method  -- still CHECK (method IN ('cash','card'))
-- payment_tips.method                       -- still CHECK (method IN ('cash','card'))
--
-- v1 is WHOLE-ORDER ONLY and carries NO PayToday gratuity. Leaving these two alone is not an
-- oversight; it is the enforcement. A split PayToday settlement, or a PayToday tip, fails LOUDLY at
-- the database rather than silently recording something the product does not support yet. The
-- settlement RPC's own `IF p_method NOT IN ('cash','card') THEN RAISE EXCEPTION` does the same.
--
-- When v1 is extended, those two constraints and that RPC are the checklist.

-- ------------------------------------------------------------------ the policy gate
--
-- Which methods a venue may CHOOSE to accept. Widened rather than replaced: hosted_checkout, eft,
-- voucher and mobile_money stay, because dropping a value some row might hold would fail to apply.
ALTER TABLE public.restaurant_settings
  DROP CONSTRAINT IF EXISTS payment_methods_valid_values;

ALTER TABLE public.restaurant_settings
  ADD CONSTRAINT payment_methods_valid_values CHECK (
    payment_methods <@ ARRAY[
      'cash', 'card', 'hosted_checkout', 'eft', 'voucher', 'mobile_money', 'paytoday'
    ]::text[]
  );

-- kiosk_payment_methods is untouched: no kiosk PayToday in v1.

-- ------------------------------------------------------------------ the settlement record
--
-- payments.method gained CHECK (cash|card|NULL) earlier today. Its only writer normalises against
-- SETTLEMENT_PAYMENT_METHODS, so this must move in the same change as that constant -- otherwise
-- the route accepts a settlement the database then rejects, AFTER the money has moved.
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_method_valid_values;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_valid_values
  CHECK (method IS NULL OR method IN ('cash', 'card', 'paytoday'));

COMMENT ON CONSTRAINT payments_method_valid_values ON public.payments IS
  'cash | card | paytoday | NULL. Mirrors SETTLEMENT_PAYMENT_METHODS in '
  'lib/payments/payment-integrity.ts -- the only writer normalises against that list, so a method '
  'added there must be added here in the same change or the route accepts a settlement the '
  'database rejects after the money has moved.';
