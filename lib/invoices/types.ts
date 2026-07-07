export type InvoiceSource = 'checkout' | 'staff'

export type InvoiceDetailsInput = {
  email: string
  company_name?: string
  companyName?: string
  vat_number?: string
  vatNumber?: string
  metadata?: Record<string, unknown>
}

export type NormalizedInvoiceDetails = {
  email: string
  companyName: string | null
  vatNumber: string | null
  metadata: Record<string, unknown>
}

export type RequestInvoiceInput = {
  orderId: string
  paymentId?: string | null
  source: InvoiceSource
  details: InvoiceDetailsInput
  idempotencyKey: string
  skipGenerationSchedule?: boolean
}

export type RequestInvoiceResult = {
  invoiceRequestId: string
  status: string
  source: InvoiceSource
  created: boolean
  isResend: boolean
  invoiceNumber: string | null
}
