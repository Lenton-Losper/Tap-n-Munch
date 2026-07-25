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

/**
 * Marks a draft quote or invoice as sent. Nothing does this implicitly today (confirmed:
 * PDF download is a pure GET, no DB write) -- this is the only place status ever moves out
 * of 'draft'.
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

    const denied = await requirePermission(user.id, String(doc.restaurant_id), PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    if (doc.status !== 'draft') {
      return NextResponse.json(
        { error: `Only draft documents can be marked as sent (current status: ${doc.status})` },
        { status: 409 },
      )
    }

    const { data: updated, error: updateError } = await supabase
      .from('business_documents')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', documentId)
      .select('*')
      .single()
    if (updateError) throw updateError

    let finalDocument = updated
    if (doc.document_type === 'invoice') {
      const recomputed = await recomputeDocumentStatus(supabase, documentId)
      finalDocument = { ...updated, status: recomputed.status, balance: recomputed.balance }
    }

    return NextResponse.json({ document: finalDocument })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to mark document as sent'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
