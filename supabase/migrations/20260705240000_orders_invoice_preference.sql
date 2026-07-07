-- Persist checkout tax-invoice opt-in on the order until payment completes.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS invoice_preference jsonb;

ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS invoice_preference jsonb;
