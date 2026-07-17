-- Receipt capability Phase 1: canonical receipt document + RCT- numbering.
-- Issuance logic lives in lib/receipts/issueReceipt.ts (Phase 1 only -- no
-- printer/email/link delivery yet, that's Phase 2-4).

-- ---------------------------------------------------------------------------
-- 1. RCT- document numbering. Mirrors the goods_received GRV- pattern
-- (dedicated sequence, prefix + LPAD-6), generalized into a callable function
-- since the issuance service needs the number up front to build the row
-- itself, rather than a BEFORE INSERT trigger.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.rct_number_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_document_number(
  p_prefix text,
  p_sequence_name text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN p_prefix || '-' || LPAD(nextval(p_sequence_name)::text, 6, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_document_number(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. receipt_documents (snapshotted, immutable sale receipts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.receipt_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  -- No outlets table exists yet. Nullable so this is forward-compatible with
  -- future multi-outlet modeling; not wired to anything today.
  outlet_id uuid,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  document_type text NOT NULL DEFAULT 'SALE_RECEIPT'
    CHECK (document_type IN ('SALE_RECEIPT')),
  document_number text NOT NULL,
  version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  currency text NOT NULL DEFAULT 'NAD',
  snapshot_json jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, document_type, version)
);

CREATE INDEX IF NOT EXISTS receipt_documents_restaurant_id_idx
  ON public.receipt_documents (restaurant_id);

CREATE INDEX IF NOT EXISTS receipt_documents_order_id_idx
  ON public.receipt_documents (order_id);

-- ---------------------------------------------------------------------------
-- 3. RLS: staff can read receipts for their own restaurant. No insert/update/
-- delete policies and no grants -- rows are written exclusively by the
-- service role (bypasses RLS), so the table is immutable at the database
-- level for application users, not just by convention.
-- ---------------------------------------------------------------------------
ALTER TABLE public.receipt_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read receipt documents for their restaurant"
  ON public.receipt_documents
  FOR SELECT
  TO authenticated
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));
