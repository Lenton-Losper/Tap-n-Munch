-- ADR: invoicing data lives in invoice_requests only — backfill then drop
-- orders.invoice_preference / tabs.invoice_preference.

-- ---------------------------------------------------------------------
-- 1. Backfill orders.invoice_preference → invoice_requests (checkout)
-- ---------------------------------------------------------------------
INSERT INTO public.invoice_requests (
  restaurant_id,
  order_id,
  payment_id,
  idempotency_key,
  source,
  status,
  company_name,
  vat_number,
  email,
  metadata
)
SELECT
  o.restaurant_id,
  o.id,
  NULL,
  'invoice:checkout:order:' || o.id::text,
  'checkout',
  'pending',
  NULLIF(TRIM(o.invoice_preference->'details'->>'company_name'), ''),
  NULLIF(TRIM(o.invoice_preference->'details'->>'vat_number'), ''),
  LOWER(TRIM(o.invoice_preference->'details'->>'email')),
  COALESCE(o.invoice_preference->'details'->'metadata', '{}'::jsonb)
FROM public.orders o
WHERE o.invoice_preference IS NOT NULL
  AND o.invoice_preference->>'requested' = 'true'
  AND NULLIF(TRIM(o.invoice_preference->'details'->>'email'), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.invoice_requests ir
    WHERE ir.order_id = o.id
  )
ON CONFLICT (idempotency_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Backfill tabs.invoice_preference → pending rows for unpaid tab orders
-- ---------------------------------------------------------------------
INSERT INTO public.invoice_requests (
  restaurant_id,
  order_id,
  payment_id,
  idempotency_key,
  source,
  status,
  company_name,
  vat_number,
  email,
  metadata
)
SELECT
  o.restaurant_id,
  o.id,
  NULL,
  'invoice:checkout:order:' || o.id::text,
  'checkout',
  'pending',
  NULLIF(TRIM(t.invoice_preference->'details'->>'company_name'), ''),
  NULLIF(TRIM(t.invoice_preference->'details'->>'vat_number'), ''),
  LOWER(TRIM(t.invoice_preference->'details'->>'email')),
  COALESCE(t.invoice_preference->'details'->'metadata', '{}'::jsonb)
FROM public.tabs t
JOIN public.orders o
  ON o.tab_id = t.id
 AND o.restaurant_id = t.restaurant_id
WHERE t.invoice_preference IS NOT NULL
  AND t.invoice_preference->>'requested' = 'true'
  AND NULLIF(TRIM(t.invoice_preference->'details'->>'email'), '') IS NOT NULL
  AND o.tab_settlement_for_tab_id IS NULL
  AND COALESCE(o.payment_status, '') <> 'paid'
  AND NOT EXISTS (
    SELECT 1
    FROM public.invoice_requests ir
    WHERE ir.order_id = o.id
  )
ON CONFLICT (idempotency_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Drop columns from core order/tab tables
-- ---------------------------------------------------------------------
ALTER TABLE public.orders
  DROP COLUMN IF EXISTS invoice_preference;

ALTER TABLE public.tabs
  DROP COLUMN IF EXISTS invoice_preference;
