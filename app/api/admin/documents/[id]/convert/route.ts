import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { createBusinessDocument, type LineItemInput } from '@/lib/documents/create-document'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

const TERMINAL_QUOTE_STATUSES = new Set(['converted', 'expired', 'declined'])

/**
 * Converts a quote into a new invoice: reads the quote's ship_to/bill_to/line_items and
 * creates the invoice via createBusinessDocument (lib/documents/create-document.ts) -- the
 * same path plain POST /api/admin/documents uses -- so the result gets a real sequence number
 * and the normal billing-profile snapshot, not a second copy of that logic. Sets the new
 * invoice's quote_id to the source quote and the source quote's status to 'converted'.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const quoteId = String(id ?? '').trim()
    if (!quoteId) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    let dueDate: string | null = null
    if (body?.due_date != null && body.due_date !== '') {
      const parsed = String(body.due_date).trim()
      if (Number.isNaN(Date.parse(parsed))) {
        return NextResponse.json({ error: 'due_date must be a valid date' }, { status: 400 })
      }
      dueDate = parsed
    }

    const supabase = createServerSupabaseClient()
    const { data: quote, error: quoteError } = await supabase
      .from('business_documents')
      .select('id, restaurant_id, document_type, status, ship_to, bill_to, line_items, reference_note')
      .eq('id', quoteId)
      .maybeSingle()
    if (quoteError) throw quoteError
    if (!quote) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const denied = await requirePermission(user.id, String(quote.restaurant_id), PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    if (quote.document_type !== 'quote') {
      return NextResponse.json({ error: 'Only quotes can be converted to an invoice' }, { status: 400 })
    }
    if (TERMINAL_QUOTE_STATUSES.has(quote.status)) {
      return NextResponse.json(
        { error: `Quote has already been ${quote.status} and cannot be converted again` },
        { status: 409 },
      )
    }

    const lineItems: LineItemInput[] = (
      Array.isArray(quote.line_items) ? quote.line_items : []
    ).map((item: Record<string, unknown>) => ({
      description: String(item.description ?? ''),
      quantity: Number(item.quantity) || 0,
      unit_price: Number(item.unit_price) || 0,
      tax_rate_id: item.tax_rate_id != null ? String(item.tax_rate_id) : null,
    }))

    const { document: invoice, warnings } = await createBusinessDocument(supabase, {
      restaurantId: String(quote.restaurant_id),
      type: 'invoice',
      shipTo: (quote.ship_to as Record<string, unknown>) ?? {},
      billTo: (quote.bill_to as Record<string, unknown>) ?? {},
      lineItems,
      dueDate,
      referenceNote: quote.reference_note,
      quoteId: quote.id,
      createdBy: user.id,
    })

    const { data: updatedQuote, error: updateError } = await supabase
      .from('business_documents')
      .update({ status: 'converted' })
      .eq('id', quoteId)
      .select('*')
      .single()
    if (updateError) throw updateError

    return NextResponse.json(
      {
        invoice,
        quote: updatedQuote,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { status: 201 },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to convert quote to invoice'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
