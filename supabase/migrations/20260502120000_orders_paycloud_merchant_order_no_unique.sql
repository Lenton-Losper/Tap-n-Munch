-- Run in Supabase SQL Editor if migrations are not applied automatically.
-- One non-null paycloud_merchant_order_no per payment (table receipts share payment_reference; only the lead row holds paycloud_merchant_order_no).
CREATE UNIQUE INDEX IF NOT EXISTS orders_paycloud_merchant_order_no_unique
ON orders (paycloud_merchant_order_no)
WHERE (paycloud_merchant_order_no IS NOT NULL);
