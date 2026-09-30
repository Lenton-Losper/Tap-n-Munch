-- @env: both
--
-- A PAYMENT TAKEN AFTER AN INVOICE WAS ISSUED REACHES THE INVOICE (Sprint 2026-09-30 brief, J8).
--
-- ==================================================================================================
-- THE DEFECT
-- ==================================================================================================
--
-- createInvoiceFromOrder/createInvoiceFromTab write `document_payments` for what the financial
-- projection says was paid AT ISSUE, and never again. An invoice raised for an unpaid (but final)
-- tab, followed by the tab being paid at the table, therefore kept printing "Amount outstanding" =
-- the full total: the PDF download, the emailed PDF, the documents list and aged-receivables all
-- read `business_documents.balance`, which only document_payments moves. A paid tab was represented
-- by an invoice demanding the whole bill -- and aged-receivables would chase the customer for it.
--
-- ==================================================================================================
-- THE RULE
-- ==================================================================================================
--
-- An invoice is a SNAPSHOT of WHAT WAS BILLED: its lines, VAT and total never change after issue
-- (the eligibility rule in lib/documents/invoice-projection.ts guarantees the covered orders' money
-- is final). What was PAID against it is not a snapshot -- it is the ledger, and the ledger moves.
-- So the application refreshes an order-/tab-linked invoice's payments from the projection every
-- time the invoice is shown or sent (lib/documents/refresh-invoice-payments.ts), through the
-- document engine's own append-only path: missing payments are ADDED as document_payments rows,
-- nothing is rewritten or deleted, and recompute-status derives balance/status as it always has.
--
-- ==================================================================================================
-- WHY A FUNCTION
-- ==================================================================================================
--
-- The refresh is "insert what is missing". Two refreshes of one invoice at once (the documents list
-- loading while the PDF downloads) would both see nothing recorded and both insert -- recording the
-- payment twice and showing the invoice as overpaid. This function takes the invoice row FOR UPDATE
-- first, so the second caller waits, then sees the first caller's rows and inserts nothing.
-- Proven in two real sessions by supabase/tests/run-invoice-payment-sync-tests.mjs.
--
-- p_records is the projection's breakdown (lib/documents/invoice-projection.ts
-- invoicePaymentRecords), integer cents, grouped by (method, reference). For each group the rows
-- already recorded under the same (method, reference) count toward it; only the shortfall is
-- inserted. A manual payment keyed by staff under a different reference is left alone and still
-- counts toward the balance, as it always did.
--
-- REFUSES (writes nothing) when the payments would exceed the document total: an invoice cannot
-- show more paid than it bills, and that state is a refund / credit-note job, never a silent row.
--
-- SAFETY: one new function, no schema change, no data write at apply time. SECURITY INVOKER; only
-- service_role may execute it (explicit REVOKE from PUBLIC, anon, authenticated -- Supabase default
-- privileges grant the latter two directly).

CREATE OR REPLACE FUNCTION public.sync_invoice_projection_payments(
    p_document_id uuid,
    p_restaurant_id uuid,
    p_records jsonb,
    p_recorded_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_doc record;
    v_rec record;
    v_total_cents bigint;
    v_recorded_before bigint;
    v_target_cents bigint := 0;
    v_existing bigint;
    v_delta bigint;
    v_planned jsonb := '[]'::jsonb;
    v_planned_cents bigint := 0;
    v_row jsonb;
BEGIN
    IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_records');
    END IF;

    -- THE LOCK. Every refresh of this invoice serialises here.
    SELECT id, document_type, status, total, created_by
      INTO v_doc
      FROM public.business_documents
     WHERE id = p_document_id AND restaurant_id = p_restaurant_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;
    IF v_doc.document_type <> 'invoice' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_invoice');
    END IF;
    -- recompute-status's TERMINAL_STATUSES: nothing moves a finished document.
    IF v_doc.status IN ('void', 'converted', 'expired', 'declined', 'cancelled') THEN
        RETURN jsonb_build_object('ok', true, 'skipped', 'terminal_status', 'inserted', 0, 'inserted_cents', 0);
    END IF;

    -- Validate EVERY record before planning any write: a bad record refuses the whole call.
    FOR v_rec IN SELECT value AS r FROM jsonb_array_elements(p_records) LOOP
        IF jsonb_typeof(v_rec.r) <> 'object'
           OR btrim(COALESCE(v_rec.r->>'method', '')) = ''
           OR COALESCE(v_rec.r->>'amount_cents', '') !~ '^[0-9]{1,12}$'
           OR (v_rec.r->>'amount_cents')::bigint <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'invalid_record', 'record', v_rec.r);
        END IF;
        v_target_cents := v_target_cents + (v_rec.r->>'amount_cents')::bigint;
    END LOOP;

    v_total_cents := round(v_doc.total * 100)::bigint;
    SELECT COALESCE(sum(round(amount * 100)), 0)::bigint
      INTO v_recorded_before
      FROM public.document_payments
     WHERE document_id = p_document_id;

    -- Plan: per (method, reference) group, the shortfall against what is already recorded.
    FOR v_rec IN
        SELECT btrim(r->>'method') AS method,
               NULLIF(btrim(COALESCE(r->>'reference', '')), '') AS reference,
               sum((r->>'amount_cents')::bigint) AS cents,
               max(NULLIF(r->>'paid_at', ''))::timestamptz AS paid_at
          FROM jsonb_array_elements(p_records) AS r
         GROUP BY 1, 2
    LOOP
        SELECT COALESCE(sum(round(amount * 100)), 0)::bigint
          INTO v_existing
          FROM public.document_payments
         WHERE document_id = p_document_id
           AND method = v_rec.method
           AND COALESCE(reference, '') = COALESCE(v_rec.reference, '');
        v_delta := v_rec.cents - v_existing;
        IF v_delta > 0 THEN
            v_planned := v_planned || jsonb_build_object(
                'method', v_rec.method, 'reference', v_rec.reference,
                'amount_cents', v_delta, 'paid_at', v_rec.paid_at);
            v_planned_cents := v_planned_cents + v_delta;
        END IF;
    END LOOP;

    -- Checked BEFORE any insert: a RETURN in plpgsql does not roll back what already ran.
    IF v_recorded_before + v_planned_cents > v_total_cents THEN
        RETURN jsonb_build_object(
            'ok', false, 'reason', 'exceeds_document_total',
            'total_cents', v_total_cents, 'recorded_cents', v_recorded_before,
            'missing_cents', v_planned_cents, 'target_cents', v_target_cents);
    END IF;

    FOR v_row IN SELECT value FROM jsonb_array_elements(v_planned) LOOP
        INSERT INTO public.document_payments (document_id, amount, method, reference, paid_at, recorded_by)
        VALUES (
            p_document_id,
            (v_row->>'amount_cents')::bigint / 100.0,
            v_row->>'method',
            v_row->>'reference',
            COALESCE(NULLIF(v_row->>'paid_at', '')::timestamptz, now()),
            COALESCE(p_recorded_by, v_doc.created_by)
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'inserted', jsonb_array_length(v_planned),
        'inserted_cents', v_planned_cents,
        'recorded_cents', v_recorded_before + v_planned_cents,
        'target_cents', v_target_cents,
        'total_cents', v_total_cents);
END;
$$;

COMMENT ON FUNCTION public.sync_invoice_projection_payments(uuid, uuid, jsonb, uuid) IS
  'Adds the document_payments rows an order/tab invoice is missing, from the financial projection, under a row lock. Append-only; refuses to exceed the document total.';

REVOKE ALL ON FUNCTION public.sync_invoice_projection_payments(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_invoice_projection_payments(uuid, uuid, jsonb, uuid) TO service_role;
