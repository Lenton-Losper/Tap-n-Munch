import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { recomputeDocumentStatus } from '@/lib/documents/recompute-status'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

async function loadDocumentForPayment(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  documentId: string,
) {
  const { data: doc, error } = await supabase
    .from('business_documents')
    .select('id, restaurant_id, document_type, status, total, balance')
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw error
  return doc
}

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
    const doc = await loadDocumentForPayment(supabase, documentId)
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const denied = await requirePermission(user.id, String(doc.restaurant_id), PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    const { data, error } = await supabase
      .from('document_payments')
      .select('id, amount, paid_at, method, reference, recorded_by, created_at')
      .eq('document_id', documentId)
      .order('paid_at', { ascending: false })
    if (error) throw error

    return NextResponse.json({ payments: data ?? [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load payments'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Records a payment against an invoice. business_documents itself is not touched here except
 * via recomputeDocumentStatus's narrow status/balance write -- the payment row is the actual
 * record, append-only (no PATCH/DELETE route exists for document_payments, and its RLS policies
 * grant only SELECT + INSERT, so even a documents:write caller cannot alter or remove one once
 * inserted).
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

    const body = await request.json()
    const amount = Number(body?.amount)
    const method = String(body?.method ?? '').trim()
    const reference = body?.reference != null ? String(body.reference).trim() || null : null

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a finite number greater than 0' }, { status: 400 })
    }
    if (!method) {
      return NextResponse.json({ error: 'method is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const doc = await loadDocumentForPayment(supabase, documentId)
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const denied = await requirePermission(user.id, String(doc.restaurant_id), PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    if (doc.document_type !== 'invoice') {
      return NextResponse.json({ error: 'Only invoices can have payments recorded' }, { status: 400 })
    }
    if (doc.status === 'draft') {
      return NextResponse.json(
        { error: 'Cannot record a payment on a draft document -- mark it sent first' },
        { status: 409 },
      )
    }
    if (doc.status === 'void') {
      return NextResponse.json({ error: 'Cannot record a payment on a voided document' }, { status: 409 })
    }
    const currentBalance = Number(doc.balance)
    if (amount > currentBalance) {
      return NextResponse.json(
        { error: `Payment amount (${amount}) exceeds the remaining balance (${currentBalance})` },
        { status: 400 },
      )
    }

    const { data: payment, error: insertError } = await supabase
      .from('document_payments')
      .insert({
        document_id: documentId,
        amount,
        method,
        reference,
        recorded_by: user.id,
      })
      .select('*')
      .single()
    if (insertError) throw insertError

    const recomputed = await recomputeDocumentStatus(supabase, documentId)

    return NextResponse.json(
      { payment, document: { status: recomputed.status, balance: recomputed.balance } },
      { status: 201 },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to record payment'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
