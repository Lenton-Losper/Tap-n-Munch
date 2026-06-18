-- Payment preference selected when customer taps Ready to Pay on a tab
ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS payment_preference text DEFAULT NULL;

ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS ready_to_pay_at timestamptz DEFAULT NULL;
