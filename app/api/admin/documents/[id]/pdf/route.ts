import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { generateDocumentPdfBytes } from '@/lib/documents/generate-document-pdf'
/**
 * `toBusinessDocumentRow` and its two party/line parsers moved to lib/ so the SEND route renders
 * the same PDF this download does. Two parsers over the same jsonb would drift, and the emailed
 * invoice would quietly stop matching the downloaded one.
 */
import { toBusinessDocumentRow } from '@/lib/documents/business-document-row'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const restaurantId = String(data.restaurant_id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    let lineage: { originalInvoiceNumber?: string | null; replacementInvoiceNumber?: string | null } | undefined
    if (data.document_type === 'credit_note' && data.credited_by_id) {
      // credit_note.credited_by_id -> original invoice; original invoice's own
      // corrected_by_id -> the replacement invoice issued alongside this credit note
      // (correct_invoice() sets both in the same transaction -- see 20260725200000).
      const { data: original } = await supabase
        .from('business_documents')
        .select('document_number, corrected_by_id')
        .eq('id', String(data.credited_by_id))
        .maybeSingle()

      let replacementNumber: string | null = null
      if (original?.corrected_by_id) {
        const { data: replacement } = await supabase
          .from('business_documents')
          .select('document_number')
          .eq('id', String(original.corrected_by_id))
          .maybeSingle()
        replacementNumber = replacement?.document_number ? String(replacement.document_number) : null
      }

      lineage = {
        originalInvoiceNumber: original?.document_number ? String(original.document_number) : null,
        replacementInvoiceNumber: replacementNumber,
      }
    }

    const document = toBusinessDocumentRow(data as Record<string, unknown>, lineage)
    const pdfBytes = await generateDocumentPdfBytes(document)
    const filename = `${document.document_type}-${document.document_number}.pdf`

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate document PDF'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
