import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

type CorrectLineItem = {
  description: string
  quantity: number
  unit_price: number
  tax_rate_id?: string | null
}

/**
 * Thin wrapper around public.correct_invoice(...): validates auth/permissions and
 * forwards corrected line items into the atomic plpgsql transaction.
 *
 * createBusinessDocument stays TypeScript for ordinary creates; correction must be
 * one DB transaction (void + credit note + replacement), so numbering/tax for that
 * path lives in the plpgsql function instead of calling the TS helper mid-flight.
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
    const documentId = String(id ?? '').trim()
    if (!documentId) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = body?.reason != null ? String(body.reason) : null
    const rawItems = Array.isArray(body?.line_items) ? body.line_items : null
    if (!rawItems || rawItems.length === 0) {
      return NextResponse.json({ error: 'line_items must be a non-empty array' }, { status: 400 })
    }

    const lineItems: CorrectLineItem[] = rawItems.map((item: Record<string, unknown>) => ({
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
        return NextResponse.json({ error: 'Each line item needs a numeric unit_price' }, { status: 400 })
      }
    }

    const supabase = createServerSupabaseClient()
    const { data: doc, error: docError } = await supabase
      .from('business_documents')
      .select('id, restaurant_id, document_type, status')
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
      return NextResponse.json({ error: 'Only invoices can be corrected' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('correct_invoice', {
      p_original_invoice_id: documentId,
      p_corrected_line_items: lineItems,
      p_reason: reason,
      p_created_by: user.id,
    })

    if (error) {
      const message = error.message || 'Failed to correct invoice'
      const clientError =
        /only invoices|only sent or overdue|payments recorded|line item|not found|required|non-empty/i.test(
          message,
        )
      return NextResponse.json({ error: message }, { status: clientError ? 409 : 500 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to correct invoice'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
