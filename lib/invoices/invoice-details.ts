import type { InvoiceDetailsInput, NormalizedInvoiceDetails } from '@/lib/invoices/types'

export function normalizeInvoiceDetails(input: InvoiceDetailsInput): NormalizedInvoiceDetails {
  const email = String(input.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) {
    throw new Error('A valid invoice email is required')
  }

  const companyName = String(input.company_name ?? input.companyName ?? '').trim() || null
  const vatNumber = String(input.vat_number ?? input.vatNumber ?? '').trim() || null
  const metadata =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : {}

  return { email, companyName, vatNumber, metadata }
}

export function buildCheckoutInvoiceIdempotencyKey(paymentReference: string, orderId: string): string {
  const ref = String(paymentReference || '').trim() || orderId
  return `invoice:checkout:${ref}`
}

/** Idempotency key for checkout opt-in captured at order placement (pre-payment). */
export function buildCheckoutOrderInvoiceIdempotencyKey(orderId: string): string {
  return `invoice:checkout:order:${String(orderId || '').trim()}`
}
