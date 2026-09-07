-- @env: both
--
-- WHICH ORDERS ARE BEING PAID FOR BY ONE CHARGE.
--
-- ================================================================================================
-- THE GAP THIS CLOSES
-- ================================================================================================
--
-- A tab settle charges the SUM of the selected orders, but nothing recorded that those orders
-- belonged to one charge. `orders.paycloud_merchant_order_no` is minted on the LEAD ROW only --
-- one non-null value per payment, enforced by a unique partial index since 2026-05-02 -- so both
-- gateway-amount gates resolve exactly one order:
--
--   app/api/terminal/orders/[orderId]/verify-payment/route.ts   called with orderIds[0]
--   app/api/webhooks/paycloud/route.ts                          resolver leg 1 finds the lead row
--
-- Each then compared the WHOLE gateway amount against ONE order's expectation and refused a
-- payment that had succeeded. For o1 = N$10, o2 = N$10 and a N$10 gratuity the reader is asked for
-- N$30, and both gates expected N$20.
--
-- This has never worked for multi-order settlements. Before pending_charge_cents existed the same
-- gates compared a summed gateway amount against a single `order.total`.
--
-- ================================================================================================
-- WHY NOT payment_events.order_ids
-- ================================================================================================
--
-- It already carries the complete set, and the resolver's leg 2 already reads it -- but
-- recordSaleEvent runs AFTER settleTab, so a webhook arriving first finds no event at all. An
-- identity the webhook cannot rely on is not an identity.
--
-- ================================================================================================
-- IT IS NOT A SECOND GATEWAY IDENTITY
-- ================================================================================================
--
-- paycloud_merchant_order_no remains THE gateway identity and the lead-order identity, unchanged
-- and unrotated. This says only "these rows are the same charge", so an expectation can be summed
-- over the right rows. Nothing is sent to PayCloud, and no PayCloud concept is added.
--
-- ITS LIFECYCLE FOLLOWS THE MERCHANT ORDER NUMBER'S. That value is minted once per order and never
-- rotated, so a repeated prepare-payment for the same active attempt returns created:false and the
-- same reference; the settlement id is reused in exactly the same cases, by reading it back off
-- the lead order rather than minting a second one.
--
-- ================================================================================================
-- NULL IS THE WHOLE SAFETY STORY
-- ================================================================================================
--
-- Every order that exists today has NULL here -- 3,317 with a merchant order number, 37 with a
-- pending charge, none with this. A NULL settlement id means NO EXPANSION, so both gates behave
-- exactly as they do now. There is nothing to backfill and no row whose behaviour changes until a
-- new prepare-payment writes one.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pending_settlement_id uuid;

-- The expansion is a lookup BY this column: "give me every order in this settlement". Partial,
-- because the overwhelming majority of rows are NULL and never participate in one.
CREATE INDEX IF NOT EXISTS orders_pending_settlement_id_idx
  ON public.orders (pending_settlement_id)
  WHERE pending_settlement_id IS NOT NULL;

COMMENT ON COLUMN public.orders.pending_settlement_id IS
  'Groups the orders being paid for by ONE charge, so verify-payment and the paycloud webhook can '
  'sum pending_charge_cents over the whole settlement instead of the lead order alone. NOT a '
  'gateway identity -- paycloud_merchant_order_no remains that, unchanged. Reused across repeated '
  'prepare-payment calls for the same attempt, mirroring the merchant order number''s no-rotation '
  'rule. NULL means no expansion and today''s single-order behaviour.';
