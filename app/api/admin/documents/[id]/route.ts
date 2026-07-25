import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { type LineItemInput, type Party } from '@/lib/documents/create-document'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

/**
 * Full document row, for the edit form to prefill from (the list endpoint only
 * returns list-display fields -- no ship_to/bill_to/line_items/reference_note).
 * Not restricted to draft invoices -- reading is safe for any document type/status,
 * same as the PDF route; only the PATCH below enforces the draft-invoice-only rule.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const documentId = String(id ?? '').trim()
    if (!documentId) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('business_documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const denied = await requirePermission(user.id, String(data.restaurant_id), PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    return NextResponse.json({ document: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load document'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Draft-only invoice edit (issue #61). Once status leaves draft, correction
 * (POST .../correct) is the supported path for sent/overdue unpaid invoices.
 *
 * Recomputes tax/totals with the same hierarchy as createBusinessDocument, then
 * updates mutable draft fields in place (document_number and seller snapshot stay).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const documentId = String(id ?? '').trim()
    if (!documentId) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const supabase = createServerSupabaseClient()
    const { data: doc, error: docError } = await supabase
      .from('business_documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle()
    if (docError) throw docError
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const denied = await requirePermission(
      user.id,
      String(doc.restaurant_id),
      PERMISSIONS.DOCUMENTS_WRITE,
    )
    if (denied) return denied

    if (doc.document_type !== 'invoice') {
      return NextResponse.json({ error: 'Only draft invoices can be edited via PATCH' }, { status: 400 })
    }
    if (doc.status !== 'draft') {
      return NextResponse.json(
        {
          error: `Only draft invoices can be edited (current status: ${doc.status}). Use the correction flow for sent invoices.`,
        },
        { status: 409 },
      )
    }

    const shipTo: Party =
      body?.ship_to != null && typeof body.ship_to === 'object'
        ? (body.ship_to as Party)
        : (doc.ship_to as Party)
    const billTo: Party =
      body?.bill_to != null && typeof body.bill_to === 'object'
        ? (body.bill_to as Party)
        : (doc.bill_to as Party)

    let dueDate: string | null = doc.due_date
    if (body?.due_date !== undefined) {
      if (body.due_date === null || body.due_date === '') {
        dueDate = null
      } else {
        const parsed = String(body.due_date).trim()
        if (Number.isNaN(Date.parse(parsed))) {
          return NextResponse.json({ error: 'due_date must be a valid date' }, { status: 400 })
        }
        dueDate = parsed
      }
    }

    let referenceNote: string | null = doc.reference_note
    if (body?.reference_note !== undefined) {
      referenceNote =
        body.reference_note == null ? null : String(body.reference_note).trim() || null
    }

    let lineItems: LineItemInput[]
    if (body?.line_items !== undefined) {
      if (!Array.isArray(body.line_items) || body.line_items.length === 0) {
        return NextResponse.json({ error: 'line_items must be a non-empty array' }, { status: 400 })
      }
      lineItems = body.line_items.map((item: Record<string, unknown>) => ({
        description: String(item?.description ?? '').trim(),
        quantity: Number(item?.quantity),
        unit_price: Number(item?.unit_price),
        tax_rate_id: item?.tax_rate_id != null ? String(item.tax_rate_id) : null,
      }))
      for (const item of lineItems) {
        if (!item.description) {
          return NextResponse.json({ error: 'Each line item needs a description' }, { status: 400 })
        }
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
          return NextResponse.json({ error: 'Each line item needs quantity > 0' }, { status: 400 })
        }
        if (!Number.isFinite(item.unit_price)) {
          return NextResponse.json(
            { error: 'Each line item needs a numeric unit_price' },
            { status: 400 },
          )
        }
      }
    } else {
      lineItems = (Array.isArray(doc.line_items) ? doc.line_items : []).map(
        (item: Record<string, unknown>) => ({
          description: String(item.description ?? ''),
          quantity: Number(item.quantity) || 0,
          unit_price: Number(item.unit_price) || 0,
          tax_rate_id: item.tax_rate_id != null ? String(item.tax_rate_id) : null,
        }),
      )
    }

    // Keep draft edits on the same row (preserve document_number). Reuse create path tax math
    // without allocating a new sequence number.
    const taxRates = await getTaxRatesForRestaurant(supabase, String(doc.restaurant_id))
    const ratesById = new Map(taxRates.map((rate) => [rate.id, rate]))
    const fallbackDefault = defaultTaxRate(taxRates)

    const computedLineItems = lineItems.map((item) => {
      const rate = resolveTaxRate(item.tax_rate_id, ratesById, fallbackDefault)
      const applied = applyTaxToAmount(item.quantity * item.unit_price, rate)
      return {
        ...item,
        tax_rate_id: rate?.id ?? null,
        tax_rate_percentage: applied.taxRatePercentage,
        tax_inclusive: applied.taxInclusive,
        line_total: round2(item.quantity * item.unit_price),
        line_subtotal: applied.subtotal,
        line_tax: applied.tax,
      }
    })
    const subtotal = round2(computedLineItems.reduce((sum, item) => sum + item.line_subtotal, 0))
    const vatAmount = round2(computedLineItems.reduce((sum, item) => sum + item.line_tax, 0))
    const total = round2(subtotal + vatAmount)

    const { data: updated, error: updateError } = await supabase
      .from('business_documents')
      .update({
        ship_to: shipTo,
        bill_to: billTo,
        due_date: dueDate,
        reference_note: referenceNote,
        line_items: computedLineItems,
        subtotal,
        vat_amount: vatAmount,
        total,
        balance: total,
      })
      .eq('id', documentId)
      .eq('status', 'draft')
      .eq('document_type', 'invoice')
      .select('*')
      .maybeSingle()
    if (updateError) throw updateError
    if (!updated) {
      return NextResponse.json(
        { error: 'Document is no longer a draft invoice and cannot be edited' },
        { status: 409 },
      )
    }

    return NextResponse.json({ document: updated })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update document'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
