import type {
  ResolvedAmendmentChange,
  StockAction,
} from '@/lib/orders/amend-types'
import type { InvoiceSource } from '@/lib/invoices/types'

export type OrderAmendedEvent = {
  event_id: string
  event_type: 'order.amended'
  occurred_at: string
  restaurant_id: string
  order_id: string
  revision_id: string
  revision_number: number
  amended_by: string
  reason: string | null
  financial_delta: number
  changes: Array<
    ResolvedAmendmentChange & {
      stock_action: StockAction
    }
  >
  order: {
    id: string
    subtotal: number
    total: number
    items: unknown[]
    status: string
    payment_status: string
  }
}

export type InvoiceDetailsPayload = {
  email: string
  company_name?: string
  vat_number?: string
  metadata?: Record<string, unknown>
}

export type PaymentCompletedEvent = {
  event_id: string
  event_type: 'payment.completed'
  occurred_at: string
  restaurant_id: string
  order_id: string
  payment_id?: string | null
  payment_reference?: string | null
  amount?: number
  invoice_requested: boolean
  invoice_details?: InvoiceDetailsPayload
}

export type InvoiceRequestedEvent = {
  event_id: string
  event_type: 'invoice.requested'
  occurred_at: string
  restaurant_id: string
  order_id: string
  invoice_request_id: string
  source: InvoiceSource
  is_resend: boolean
}

export type InvoiceGeneratedEvent = {
  event_id: string
  event_type: 'invoice.generated'
  occurred_at: string
  restaurant_id: string
  order_id: string
  invoice_request_id: string
  invoice_number: string
  email: string
  status: 'sent'
  pdf_storage_path: string
  restaurant_name: string
}
