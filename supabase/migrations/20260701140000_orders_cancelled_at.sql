-- Add cancelled_at for order cancellation timestamp (matches status route TIMESTAMP_FIELDS).

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
