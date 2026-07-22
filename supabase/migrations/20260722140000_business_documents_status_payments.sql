-- Extension pass (approved 2026-07-22) on top of the Business Documents feature (Issue #19):
-- status lifecycle + append-only partial-payment ledger. Supersedes the separate-tables
-- invoicing ADR for schema/numbering/immutability/permissions/business-details purposes --
-- business_documents, document_sequences and restaurant_billing_profiles stay exactly as
-- originally shipped.
--
-- business_documents itself remains otherwise immutable: the only two write paths this adds
-- are POST .../send (draft -> sent) and POST .../payments (inserts document_payments, then
-- recomputes status/balance here) -- there is still no general-purpose PATCH/PUT and none is
-- planned. status/balance are the only mutable fields on an existing row.

ALTER TABLE public.business_documents
  ADD COLUMN status text NOT NULL DEFAULT 'draft',
  ADD COLUMN sent_at timestamptz;

-- One conditional CHECK covering both document types, rather than a trigger or two separate
-- constraints -- invoice and quote status sets are deliberately disjoint so a quote row can
-- never carry an invoice-only status (e.g. 'paid') or vice versa.
-- 'void' (invoice) and 'expired'/'declined' (quote) are reserved for a future pass -- no action
-- sets them yet, they're just valid, currently-unreachable states.
ALTER TABLE public.business_documents
  ADD CONSTRAINT business_documents_status_check CHECK (
    (document_type = 'invoice' AND status IN ('draft', 'sent', 'paid', 'partially_paid', 'overdue', 'void'))
    OR
    (document_type = 'quote' AND status IN ('draft', 'sent', 'converted', 'expired', 'declined'))
  );

-- Supports both the documents list (status badge) and the aged-receivables report
-- (status IN (...) AND due_date < now()).
CREATE INDEX IF NOT EXISTS business_documents_restaurant_status_due_idx
  ON public.business_documents (restaurant_id, status, due_date)
  WHERE document_type = 'invoice';

-- ---------------------------------------------------------------------------
-- document_payments: append-only partial-payment ledger, one row per payment recorded
-- against an invoice. Mirrors payment_events discipline -- no update/delete path, ever,
-- at the application layer or the RLS layer (only SELECT + INSERT policies exist below;
-- there is deliberately no UPDATE/DELETE policy, so even a client holding documents:write
-- cannot modify or remove a payment row once inserted).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.business_documents(id),
  amount numeric NOT NULL,
  CONSTRAINT document_payments_amount_positive CHECK (amount > 0),
  paid_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  reference text,
  recorded_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_payments_document_id_idx
  ON public.document_payments (document_id);

ALTER TABLE public.document_payments ENABLE ROW LEVEL SECURITY;

-- No restaurant_id column on this table (per the approved schema) -- scope via a join to the
-- parent document's restaurant_id, same permission model business_documents already uses.
CREATE POLICY "Authorized staff can read document payments"
  ON public.document_payments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.business_documents bd
      WHERE bd.id = document_payments.document_id
        AND public.user_has_permission(bd.restaurant_id, 'documents:read')
    )
  );

CREATE POLICY "Authorized staff can record document payments"
  ON public.document_payments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.business_documents bd
      WHERE bd.id = document_payments.document_id
        AND public.user_has_permission(bd.restaurant_id, 'documents:write')
    )
  );
