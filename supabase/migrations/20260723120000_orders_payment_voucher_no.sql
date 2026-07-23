-- Separate gateway voucher identity from Finatic merchant_order_no / payment_reference.
-- paycloud_merchant_order_no remains the webhook correlation key (set at prepare-payment).
-- payment_voucher_no stores the Wiseasy/Finatic voucher when the terminal reports it.

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS payment_voucher_no text;

COMMENT ON COLUMN public.orders.payment_voucher_no IS
  'Gateway voucher / approval reference from the terminal (distinct from paycloud_merchant_order_no).';

COMMENT ON COLUMN public.orders.paycloud_merchant_order_no IS
  'Finatic merchant_order_no / businessOrderNo used on notifyUrl webhooks. Allocated before payment for terminal POS.';

COMMENT ON COLUMN public.orders.payment_reference IS
  'Legacy settlement reference field. May still hold voucher or other refs for older clients; prefer payment_voucher_no + paycloud_merchant_order_no for new writes.';
