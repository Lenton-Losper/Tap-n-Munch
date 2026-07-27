-- correct_invoice has no authorization logic of its own; it relies entirely on
-- the calling API route's requirePermission check. EXECUTE is currently
-- restricted to service_role only (20260727140000 / 20260727150000), so there
-- is no live direct-authenticated-RPC path today -- but that grant is exactly
-- the kind of thing that silently regressed once already this sweep (the
-- PUBLIC-default-grant gap fixed in 20260727150000). Add an internal check so
-- the function is safe on its own, independent of both the route's check and
-- the current grant state.
--
-- The API route calls this RPC through a service_role client with no user JWT
-- forwarded, so auth.uid() is NULL on that (currently the only real) call
-- path -- enforcing user_has_permission() unconditionally would reject every
-- legitimate correction. auth.role() reads the JWT-claims GUC PostgREST sets
-- per request (the same mechanism auth.uid() itself relies on), so unlike
-- current_user/session_user it is NOT clobbered by this function's own
-- SECURITY DEFINER (current_user turns into the function owner, e.g.
-- "postgres", inside a SECURITY DEFINER body -- confirmed empirically on
-- staging: a real service_role call reported current_user='postgres',
-- session_user='authenticator', and only auth.role() correctly returned
-- 'service_role'). It also cannot be spoofed by the caller. So: skip the
-- internal check for service_role calls (already gated by the route's own
-- requirePermission), and enforce user_has_permission() -- using the
-- caller's real auth.uid() -- for any direct authenticated-role call.

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

  -- Internal tenant/permission check: independent of the calling route and of
  -- the function's current EXECUTE grants. service_role calls (the API
  -- route's own path) are trusted, since the route already ran its own
  -- requirePermission check; any direct authenticated-role call must pass
  -- user_has_permission() against the invoice's actual restaurant_id.
  IF auth.role() <> 'service_role'
     AND NOT public.user_has_permission(v_original.restaurant_id, 'documents:write') THEN
    RAISE EXCEPTION 'Insufficient permission to correct invoices for this restaurant'
      USING ERRCODE = '42501';
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

-- Grants are unchanged (service_role only, per 20260727150000); re-asserted
-- here defensively since CREATE OR REPLACE FUNCTION does not reset existing
-- grants but a future copy/paste of this file as a template should not
-- silently reopen PUBLIC/authenticated access.
REVOKE ALL ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) TO service_role;
