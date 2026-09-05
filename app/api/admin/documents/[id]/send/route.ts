import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { recomputeDocumentStatus } from '@/lib/documents/recompute-status'
import { recipientEmail } from '@/lib/documents/business-document-row'
import { sendDocumentEmail } from '@/lib/documents/sendDocumentEmail'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

/**
 * Emails a draft quote or invoice to its Bill To address, with the PDF attached, and only then
 * marks it sent.
 *
 * WHAT THIS USED TO DO. It set `status = 'sent'`, stamped `sent_at`, and returned 200 without
 * contacting anybody -- its own docstring said "Marks a draft quote or invoice as sent". A staff
 * member pressed Send, the row said sent, and nothing reached the customer. All three invoices on
 * production are still `draft`, so no document has ever been delivered by any route.
 *
 * ORDER MATTERS AND IS DELIBERATE: send first, mark second.
 *
 *   - A failed send leaves the document in `draft`, so it can simply be sent again. There is no
 *     half-state to clean up and no "sent" row for an email that never went.
 *   - Marking sent before sending would reintroduce exactly the defect this replaces, and worse:
 *     `aged-receivables` reports unpaid non-draft invoices past their due date, so a lie here
 *     starts chasing a customer for an invoice they were never sent.
 *
 * NO EMAIL ADDRESS IS A REFUSAL, NOT A GUESS. `bill_to.email` is optional in the document form
 * (`document-form-modal.tsx:409` requires only a name), so a valid document can have nowhere to
 * go. It returns 422 and changes nothing rather than falling back to the venue's own address or
 * the creating user's -- either would send a customer's invoice to the wrong person and report
 * success.
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
    // `*` because the PDF is rendered from this row -- the same columns the download route reads.
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

    if (doc.status !== 'draft') {
      return NextResponse.json(
        { error: `Only draft documents can be sent (current status: ${doc.status})` },
        { status: 409 },
      )
    }

    const to = recipientEmail(doc)
    if (!to) {
      return NextResponse.json(
        {
          error:
            'This document has no Bill To email address, so there is nowhere to send it. ' +
            'Add one to the document and try again.',
          code: 'NO_RECIPIENT_EMAIL',
        },
        { status: 422 },
      )
    }

    const sent = await sendDocumentEmail(supabase, doc, to, user.id)
    if (!sent.ok) {
      // Left in draft on purpose: nothing to undo, and Send can be pressed again.
      return NextResponse.json(
        {
          error: `The email could not be sent: ${sent.errorMessage}`,
          code: 'EMAIL_SEND_FAILED',
          to: sent.to,
        },
        { status: 502 },
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

    return NextResponse.json({ document: finalDocument, emailedTo: sent.to })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to send document'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
