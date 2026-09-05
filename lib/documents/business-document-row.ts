/**
 * Parsing a `business_documents` row into the shape the PDF renderer wants.
 *
 * MOVED HERE FROM `app/api/admin/documents/[id]/pdf/route.ts`, UNCHANGED, so that the send route
 * can render the same PDF the download gives you. The alternative was a second copy of
 * `toBusinessDocumentRow`, and two parsers over the same jsonb columns drift: the moment one of
 * them learns about a new `bill_to` field or a fourth document type, the emailed invoice and the
 * downloaded one stop being the same document. There is one parser and both callers use it.
 */

import type {
  BusinessDocumentRow,
  DocumentLineItem,
  DocumentParty,
} from '@/lib/documents/generate-document-pdf'

export function parseParty(value: unknown): DocumentParty {
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

export function parseLineItems(value: unknown): DocumentLineItem[] {
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

export function toBusinessDocumentRow(
  row: Record<string, unknown>,
  lineage?: { originalInvoiceNumber?: string | null; replacementInvoiceNumber?: string | null },
): BusinessDocumentRow {
  const documentType = String(row.document_type ?? '')
  if (documentType !== 'quote' && documentType !== 'invoice' && documentType !== 'credit_note') {
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
    original_invoice_number: lineage?.originalInvoiceNumber ?? null,
    replacement_invoice_number: lineage?.replacementInvoiceNumber ?? null,
  }
}

/**
 * The address an invoice is sent to, or null.
 *
 * `bill_to.email` is OPTIONAL in the document form — `document-form-modal.tsx:409` requires only a
 * name — so a perfectly valid invoice can have nowhere to go. That is a refusal at send time, not
 * a reason to guess: there is no fallback to the restaurant's own address or to the creating
 * user's, because both would send the customer's invoice to the wrong person and look like it
 * worked.
 */
export function recipientEmail(row: { bill_to?: unknown }): string | null {
  const email = parseParty(row.bill_to).email?.trim() ?? ''
  // Deliberately shallow: enough to catch an empty or obviously-not-an-address value before
  // handing it to the provider, and not an attempt to validate email syntax, which is a job
  // nothing does well and Resend does better.
  if (!email || !email.includes('@')) return null
  return email
}
