-- Document Engine: credit_note type, lineage columns, sequence support, correct_invoice().
-- Staging first; production requires explicit sign-off.

-- ---------------------------------------------------------------------------
-- 1. document_type CHECK: add credit_note
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_documents
  DROP CONSTRAINT IF EXISTS business_documents_document_type_check;

ALTER TABLE public.business_documents
  ADD CONSTRAINT business_documents_document_type_check
  CHECK (document_type IN ('quote', 'invoice', 'credit_note'));

-- ---------------------------------------------------------------------------
-- 2. status CHECK: credit_note => issued | cancelled
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_documents
  DROP CONSTRAINT IF EXISTS business_documents_status_check;

ALTER TABLE public.business_documents
  ADD CONSTRAINT business_documents_status_check CHECK (
    (document_type = 'invoice' AND status IN ('draft', 'sent', 'paid', 'partially_paid', 'overdue', 'void'))
    OR
    (document_type = 'quote' AND status IN ('draft', 'sent', 'converted', 'expired', 'declined'))
    OR
    (document_type = 'credit_note' AND status IN ('issued', 'cancelled'))
  );

-- ---------------------------------------------------------------------------
-- 3. Lineage columns (self-referential, nullable)
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_documents
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES public.business_documents(id),
  ADD COLUMN IF NOT EXISTS corrected_by_id uuid REFERENCES public.business_documents(id),
  ADD COLUMN IF NOT EXISTS credited_by_id uuid REFERENCES public.business_documents(id);

CREATE INDEX IF NOT EXISTS business_documents_supersedes_id_idx
  ON public.business_documents (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_documents_corrected_by_id_idx
  ON public.business_documents (corrected_by_id)
  WHERE corrected_by_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_documents_credited_by_id_idx
  ON public.business_documents (credited_by_id)
  WHERE credited_by_id IS NOT NULL;

-- Credit notes that credit an invoice: credit_note.credited_by_id = invoice.id
COMMENT ON COLUMN public.business_documents.supersedes_id IS
  'Replacement document points at the document it supersedes (e.g. corrected invoice → original).';
COMMENT ON COLUMN public.business_documents.corrected_by_id IS
  'Original document points at its replacement after correction.';
COMMENT ON COLUMN public.business_documents.credited_by_id IS
  'On a credit_note: the invoice this credit note credits. On an invoice: optional back-pointer unused by correction (prefer querying credit_notes by credited_by_id).';

-- ---------------------------------------------------------------------------
-- 4. document_sequences + get_next_document_number / set_document_sequence_start
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_sequences
  DROP CONSTRAINT IF EXISTS document_sequences_document_type_check;

ALTER TABLE public.document_sequences
  ADD CONSTRAINT document_sequences_document_type_check
  CHECK (document_type IN ('quote', 'invoice', 'credit_note'));

CREATE OR REPLACE FUNCTION public.get_next_document_number(
  p_restaurant_id uuid,
  p_document_type text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next integer;
BEGIN
  IF p_document_type NOT IN ('quote', 'invoice', 'credit_note') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  INSERT INTO public.document_sequences (restaurant_id, document_type, current_number)
  VALUES (p_restaurant_id, p_document_type, 0)
  ON CONFLICT (restaurant_id, document_type) DO NOTHING;

  UPDATE public.document_sequences
  SET current_number = current_number + 1
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type
  RETURNING current_number INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Failed to reserve document number for restaurant % type %', p_restaurant_id, p_document_type;
  END IF;

  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_document_sequence_start(
  p_restaurant_id uuid,
  p_document_type text,
  p_start_at integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current integer;
  v_target integer;
BEGIN
  IF p_document_type NOT IN ('quote', 'invoice', 'credit_note') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  IF p_start_at IS NULL OR p_start_at < 1 THEN
    RAISE EXCEPTION 'p_start_at must be a positive integer';
  END IF;

  v_target := p_start_at - 1;

  INSERT INTO public.document_sequences (restaurant_id, document_type, current_number)
  VALUES (p_restaurant_id, p_document_type, v_target)
  ON CONFLICT (restaurant_id, document_type) DO NOTHING;

  SELECT current_number
  INTO v_current
  FROM public.document_sequences
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Document sequence row missing for restaurant % type %', p_restaurant_id, p_document_type;
  END IF;

  IF p_start_at <= v_current THEN
    RAISE EXCEPTION
      'Cannot set document sequence backward: requested start % but current counter is %',
      p_start_at,
      v_current;
  END IF;

  UPDATE public.document_sequences
  SET current_number = v_target
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. correct_invoice — single atomic correction transaction
--
-- Approach note: createBusinessDocument is TypeScript (tax_rates lookup + JSON insert).
-- It cannot be invoked from plpgsql inside one DB transaction with the void/link updates.
-- Cleaner path: port the same numbering (get_next_document_number) + tax hierarchy into
-- this function so validation, inserts, and lineage updates share one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_invoice(
  p_original_invoice_id uuid,
  p_corrected_line_items jsonb,
  p_reason text,
  p_created_by uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_original public.business_documents%ROWTYPE;
  v_payment_count integer;
  v_default_rate_id uuid;
  v_default_pct numeric := 0;
  v_default_inclusive boolean := true;
  v_rate_id uuid;
  v_item jsonb;
  v_qty numeric;
  v_unit numeric;
  v_raw numeric;
  v_pct numeric;
  v_inclusive boolean;
  v_line_subtotal numeric;
  v_line_tax numeric;
  v_line_total numeric;
  v_desc text;
  v_computed_items jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_vat numeric := 0;
  v_total numeric := 0;
  v_invoice_number integer;
  v_credit_number integer;
  v_new_invoice public.business_documents%ROWTYPE;
  v_credit_note public.business_documents%ROWTYPE;
  v_credit_items jsonb;
  v_reason text;
BEGIN
  IF p_original_invoice_id IS NULL THEN
    RAISE EXCEPTION 'original_invoice_id is required';
  END IF;
  IF p_created_by IS NULL THEN
    RAISE EXCEPTION 'created_by is required';
  END IF;
  IF p_corrected_line_items IS NULL OR jsonb_typeof(p_corrected_line_items) <> 'array'
     OR jsonb_array_length(p_corrected_line_items) = 0 THEN
    RAISE EXCEPTION 'corrected_line_items must be a non-empty JSON array';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');

  SELECT *
  INTO v_original
  FROM public.business_documents
  WHERE id = p_original_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_original.document_type <> 'invoice' THEN
    RAISE EXCEPTION 'Only invoices can be corrected (got %)', v_original.document_type;
  END IF;

  IF v_original.status NOT IN ('sent', 'overdue') THEN
    RAISE EXCEPTION
      'Only sent or overdue unpaid invoices can be corrected (current status: %)',
      v_original.status;
  END IF;

  SELECT count(*)::integer
  INTO v_payment_count
  FROM public.document_payments
  WHERE document_id = p_original_invoice_id;

  IF v_payment_count > 0 THEN
    RAISE EXCEPTION
      'Cannot correct an invoice that has payments recorded (found % payment row(s)); paid/partially-paid correction is a separate workflow',
      v_payment_count;
  END IF;

  SELECT id, percentage, is_inclusive
  INTO v_default_rate_id, v_default_pct, v_default_inclusive
  FROM public.tax_rates
  WHERE restaurant_id = v_original.restaurant_id
    AND is_default = true
  LIMIT 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_corrected_line_items)
  LOOP
    v_desc := COALESCE(v_item->>'description', '');
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit := COALESCE((v_item->>'unit_price')::numeric, 0);
    IF trim(v_desc) = '' THEN
      RAISE EXCEPTION 'Each line item needs a description';
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Each line item needs quantity > 0';
    END IF;
    v_raw := round((v_qty * v_unit)::numeric, 2);

    v_rate_id := NULL;
    v_pct := NULL;
    v_inclusive := NULL;
    IF NULLIF(v_item->>'tax_rate_id', '') IS NOT NULL THEN
      SELECT id, percentage, is_inclusive
      INTO v_rate_id, v_pct, v_inclusive
      FROM public.tax_rates
      WHERE id = (v_item->>'tax_rate_id')::uuid
        AND restaurant_id = v_original.restaurant_id;
    END IF;
    IF v_rate_id IS NULL THEN
      v_rate_id := v_default_rate_id;
      v_pct := v_default_pct;
      v_inclusive := v_default_inclusive;
    END IF;

    IF v_rate_id IS NULL OR COALESCE(v_pct, 0) = 0 THEN
      v_line_total := v_raw;
      v_line_subtotal := v_raw;
      v_line_tax := 0;
      v_pct := 0;
      v_inclusive := true;
    ELSE
      v_inclusive := COALESCE(v_inclusive, true);
      IF v_inclusive THEN
        v_line_total := v_raw;
        v_line_tax := round((v_line_total - v_line_total / (1 + v_pct / 100))::numeric, 2);
        v_line_subtotal := round((v_line_total - v_line_tax)::numeric, 2);
      ELSE
        v_line_subtotal := v_raw;
        v_line_tax := round((v_line_subtotal * v_pct / 100)::numeric, 2);
        v_line_total := round((v_line_subtotal + v_line_tax)::numeric, 2);
      END IF;
    END IF;

    v_computed_items := v_computed_items || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'description', v_desc,
          'quantity', v_qty,
          'unit_price', v_unit,
          'tax_rate_id', v_rate_id,
          'tax_rate_percentage', v_pct,
          'tax_inclusive', v_inclusive,
          'line_total', v_line_total,
          'line_subtotal', v_line_subtotal,
          'line_tax', v_line_tax
        )
      )
    );

    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat := v_vat + v_line_tax;
  END LOOP;

  v_subtotal := round(v_subtotal::numeric, 2);
  v_vat := round(v_vat::numeric, 2);
  v_total := round((v_subtotal + v_vat)::numeric, 2);

  v_invoice_number := public.get_next_document_number(v_original.restaurant_id, 'invoice');
  v_credit_number := public.get_next_document_number(v_original.restaurant_id, 'credit_note');

  -- Credit note mirrors the original invoice amounts (full credit of the voided invoice).
  v_credit_items := v_original.line_items;

  INSERT INTO public.business_documents (
    restaurant_id,
    document_type,
    document_number,
    quote_id,
    issued_at,
    due_date,
    reference_note,
    business_name,
    registration_number,
    vat_number,
    address,
    phone,
    logo_url,
    bank_name,
    bank_account_name,
    bank_account_number,
    bank_branch_code,
    ship_to,
    bill_to,
    line_items,
    subtotal,
    vat_amount,
    total,
    balance,
    currency,
    created_by,
    status,
    supersedes_id
  ) VALUES (
    v_original.restaurant_id,
    'invoice',
    v_invoice_number::text,
    v_original.quote_id,
    now(),
    v_original.due_date,
    CASE
      WHEN v_reason IS NULL THEN v_original.reference_note
      WHEN v_original.reference_note IS NULL OR v_original.reference_note = '' THEN v_reason
      ELSE v_original.reference_note || E'\nCorrection: ' || v_reason
    END,
    v_original.business_name,
    v_original.registration_number,
    v_original.vat_number,
    v_original.address,
    v_original.phone,
    v_original.logo_url,
    v_original.bank_name,
    v_original.bank_account_name,
    v_original.bank_account_number,
    v_original.bank_branch_code,
    v_original.ship_to,
    v_original.bill_to,
    v_computed_items,
    v_subtotal,
    v_vat,
    v_total,
    v_total,
    v_original.currency,
    p_created_by,
    'draft',
    v_original.id
  )
  RETURNING * INTO v_new_invoice;

  INSERT INTO public.business_documents (
    restaurant_id,
    document_type,
    document_number,
    issued_at,
    reference_note,
    business_name,
    registration_number,
    vat_number,
    address,
    phone,
    logo_url,
    bank_name,
    bank_account_name,
    bank_account_number,
    bank_branch_code,
    ship_to,
    bill_to,
    line_items,
    subtotal,
    vat_amount,
    total,
    balance,
    currency,
    created_by,
    status,
    credited_by_id
  ) VALUES (
    v_original.restaurant_id,
    'credit_note',
    v_credit_number::text,
    now(),
    CASE
      WHEN v_reason IS NULL THEN 'Credit note for invoice ' || v_original.document_number
      ELSE 'Credit note for invoice ' || v_original.document_number || ': ' || v_reason
    END,
    v_original.business_name,
    v_original.registration_number,
    v_original.vat_number,
    v_original.address,
    v_original.phone,
    v_original.logo_url,
    v_original.bank_name,
    v_original.bank_account_name,
    v_original.bank_account_number,
    v_original.bank_branch_code,
    v_original.ship_to,
    v_original.bill_to,
    v_credit_items,
    v_original.subtotal,
    v_original.vat_amount,
    v_original.total,
    0,
    v_original.currency,
    p_created_by,
    'issued',
    v_original.id
  )
  RETURNING * INTO v_credit_note;

  UPDATE public.business_documents
  SET
    status = 'void',
    corrected_by_id = v_new_invoice.id,
    balance = 0
  WHERE id = v_original.id;

  RETURN jsonb_build_object(
    'original_invoice_id', v_original.id,
    'replacement_invoice', to_jsonb(v_new_invoice),
    'credit_note', to_jsonb(v_credit_note)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) TO authenticated, service_role;
