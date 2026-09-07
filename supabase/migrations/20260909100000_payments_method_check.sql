-- @env: both
--
-- CONSTRAIN payments.method TO THE METHODS A SETTLEMENT CAN ACTUALLY RECORD.
--
-- ================================================================================================
-- WHY THIS COLUMN AND NOT THE OTHER THREE
-- ================================================================================================
--
-- Four columns carry a payment method, and until now they disagreed about who constrains them:
--
--   payments.method                            NO constraint. text, DEFAULT 'card'.   <- this one
--   orders.payment_method                      NO constraint.
--   order_line_allocation_settlements.method   CHECK (method IN ('cash','card'))
--   payment_tips.method                        CHECK (method IN ('cash','card'))
--
-- THE ASYMMETRY IS THE ARGUMENT. A third method -- PayToday, being scoped now -- would have been
-- ACCEPTED SILENTLY by the whole-order path, which writes payments.method, and REJECTED WITH AN
-- EXCEPTION by the by-item path, which goes through settle_order_line_allocations(). One venue
-- would have had part of its takings recorded and part of them fail, with no single symptom
-- pointing at the cause. Either behaviour alone is survivable; the two together are not.
--
-- orders.payment_method IS DELIBERATELY NOT CONSTRAINED HERE, and it would be wrong to. It is
-- validated at the route against restaurant_settings.payment_methods, whose own CHECK permits six
-- values -- cash, card, hosted_checkout, eft, voucher, mobile_money. A cash-or-card CHECK on
-- orders would contradict the venue allowlist that already governs it and would refuse a
-- hosted_checkout order the product is designed to accept.
--
-- ================================================================================================
-- THE VALUES THAT ARE ACTUALLY IN THERE
-- ================================================================================================
--
-- Audited against production 2026-09-09 (scripts/prod/audit-payment-method-values.mjs), identity
-- verified from the database three ways:
--
--   payments.method     "card"  12 rows   2026-06-25 .. 2026-09-01
--                       "cash"   1 row    2026-08-17
--                       NULL     0 rows
--
-- Nothing to migrate and nothing to reject. Thirteen rows in total, because `payments` has exactly
-- ONE writer -- app/api/terminal/tabs/[tabId]/settle/route.ts -- while orders.payment_method has
-- eight and 3,909 rows. This constraint is cheap and narrow by construction.
--
-- ================================================================================================
-- IT MIRRORS SETTLEMENT_PAYMENT_METHODS, AND MUST KEEP DOING SO
-- ================================================================================================
--
-- The only writer takes its value from normalizeSettlementPaymentMethod(), which accepts exactly
-- SETTLEMENT_PAYMENT_METHODS (lib/payments/payment-integrity.ts). So this constraint can never
-- refuse something the application would legitimately write -- today. WHEN A METHOD IS ADDED THERE
-- IT MUST BE ADDED HERE IN THE SAME CHANGE, or the route will accept a settlement the database
-- then rejects, which fails AFTER the money has moved.
--
-- ================================================================================================
-- NULL IS ALLOWED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT
-- ================================================================================================
--
-- A CHECK passes unless it evaluates to FALSE, so `method IN ('cash','card')` is SATISFIED by NULL.
-- Writing it this way and calling it "cash or card only" would be wrong, so it is said plainly:
-- this permits cash, card, or unknown.
--
-- The column is left nullable on purpose. There are 0 nulls today, but NOT NULL on a money table is
-- a separate change with a separate blast radius, and adding it inside a constraint migration would
-- smuggle it past review. If it is wanted, it is its own migration.
--
-- Forward-only and reversible: DROP CONSTRAINT restores today's behaviour exactly.

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_method_valid_values;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_valid_values
  CHECK (method IS NULL OR method IN ('cash', 'card'));

COMMENT ON CONSTRAINT payments_method_valid_values ON public.payments IS
  'cash | card | NULL. Mirrors SETTLEMENT_PAYMENT_METHODS in lib/payments/payment-integrity.ts -- '
  'the only writer normalises against that list, so a method added there must be added here in the '
  'same change or the route accepts a settlement the database rejects after the money has moved.';
