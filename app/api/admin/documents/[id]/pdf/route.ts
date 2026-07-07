import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import {
  generateDocumentPdfBytes,
  type BusinessDocumentRow,
  type DocumentLineItem,
  type DocumentParty,
} from '@/lib/documents/generate-document-pdf'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

function parseParty(value: unknown): DocumentParty {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const row = value as Record<string, unknown>
  const customFields =
    row.customFields && typeof row.customFields === 'object' && !Array.isArray(row.customFields)
      ? (row.customFields as Record<string, string>)
      : undefined
  return {
    name: row.name != null ? String(row.name) : undefined,
    email: row.email != null ? String(row.email) : undefined,
    organization: row.organization != null ? String(row.organization) : undefined,
    phone: row.phone != null ? String(row.phone) : undefined,
    customFields,
  }
}

function parseLineItems(value: unknown): DocumentLineItem[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const row = item as Record<string, unknown>
      return {
        description: String(row.description ?? ''),
        quantity: Number(row.quantity) || 0,
        unit_price: Number(row.unit_price) || 0,
        line_total: Number(row.line_total) || 0,
      }
    })
}

function toBusinessDocumentRow(row: Record<string, unknown>): BusinessDocumentRow {
  const documentType = String(row.document_type ?? '')
  if (documentType !== 'quote' && documentType !== 'invoice') {
    throw new Error('Invalid document type')
  }

  return {
    id: String(row.id),
    restaurant_id: String(row.restaurant_id),
    document_type: documentType,
    document_number: String(row.document_number),
    quote_id: row.quote_id != null ? String(row.quote_id) : null,
    issued_at: String(row.issued_at),
    due_date: row.due_date != null ? String(row.due_date) : null,
    reference_note: row.reference_note != null ? String(row.reference_note) : null,
    business_name: row.business_name != null ? String(row.business_name) : null,
    registration_number:
      row.registration_number != null ? String(row.registration_number) : null,
    vat_number: row.vat_number != null ? String(row.vat_number) : null,
    address: row.address != null ? String(row.address) : null,
    phone: row.phone != null ? String(row.phone) : null,
    logo_url: row.logo_url != null ? String(row.logo_url) : null,
    bank_name: row.bank_name != null ? String(row.bank_name) : null,
    bank_account_name:
      row.bank_account_name != null ? String(row.bank_account_name) : null,
    bank_account_number:
      row.bank_account_number != null ? String(row.bank_account_number) : null,
    bank_branch_code: row.bank_branch_code != null ? String(row.bank_branch_code) : null,
    ship_to: parseParty(row.ship_to),
    bill_to: parseParty(row.bill_to),
    line_items: parseLineItems(row.line_items),
    subtotal: Number(row.subtotal) || 0,
    vat_amount: Number(row.vat_amount) || 0,
    total: Number(row.total) || 0,
    balance: Number(row.balance) || 0,
    currency: String(row.currency ?? 'NAD'),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  }
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

    const document = toBusinessDocumentRow(data as Record<string, unknown>)
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
