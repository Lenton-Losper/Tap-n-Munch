-- Invoice request source tracking (checkout vs staff callback).
-- Optional seller billing fields for tax invoice PDF headers.

ALTER TABLE public.invoice_requests
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'checkout';

ALTER TABLE public.invoice_requests DROP CONSTRAINT IF EXISTS invoice_requests_source_check;
ALTER TABLE public.invoice_requests
  ADD CONSTRAINT invoice_requests_source_check
  CHECK (source IN ('checkout', 'staff'));

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS company_reg_number text;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS vat_number text;
