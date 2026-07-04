-- Add 'pos' as a valid order channel for waiter-initiated POS orders.
-- Part of the FlashTap Platform Architecture Vision v1.0 —
-- channel describes the origin of an order, not the device used.

-- Drop both possible constraint names (inline unnamed → orders_channel_check,
-- or previously named valid_order_channel) before recreating.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_channel_check;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS valid_order_channel;

ALTER TABLE public.orders
  ADD CONSTRAINT valid_order_channel
  CHECK (channel IN ('table', 'kiosk', 'pos', 'online', 'delivery'));
