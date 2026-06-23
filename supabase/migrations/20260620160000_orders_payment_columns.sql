-- Terminal payment completion: order payment fields (idempotent)

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS payment_reference TEXT,
ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid',
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
