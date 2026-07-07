import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildCheckoutOrderInvoiceIdempotencyKey,
  normalizeInvoiceDetails,
} from '@/lib/invoices/invoice-details'
import type { InvoiceDetailsInput } from '@/lib/invoices/types'
import { emitInvoiceRequested } from '@/lib/events/emit-invoice-requested'
import { scheduleInvoiceGeneration } from '@/lib/invoices/schedule-invoice-generation'

export class CheckoutInvoiceRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CheckoutInvoiceRequestError'
    this.status = status
  }
}

export async function findPendingCheckoutInvoiceRequest(
  supabase: SupabaseClient,
  orderId: string,
) {
  const { data, error } = await supabase
    .from('invoice_requests')
    .select('id, status, source, payment_id')
    .eq('order_id', orderId)
    .eq('source', 'checkout')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data
}

/**
 * Creates a pending checkout invoice request as soon as the customer opts in
 * at order placement (before payment).
 */
export async function createPendingCheckoutInvoiceRequest(
  supabase: SupabaseClient,
  input: {
    orderId: string
    restaurantId: string
    details: InvoiceDetailsInput
  },
): Promise<{ invoiceRequestId: string; created: boolean }> {
  const orderId = String(input.orderId || '').trim()
  const restaurantId = String(input.restaurantId || '').trim()
  if (!orderId) throw new CheckoutInvoiceRequestError('order_id is required')
  if (!restaurantId) throw new CheckoutInvoiceRequestError('restaurant_id is required')

  const details = normalizeInvoiceDetails(input.details)
  const idempotencyKey = buildCheckoutOrderInvoiceIdempotencyKey(orderId)

  const { data: existingForOrder, error: existingOrderError } = await supabase
    .from('invoice_requests')
    .select('id, status, source')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingOrderError) throw existingOrderError
  if (existingForOrder) {
    return { invoiceRequestId: String(existingForOrder.id), created: false }
  }

  const { data: existingByKey, error: existingKeyError } = await supabase
    .from('invoice_requests')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (existingKeyError) throw existingKeyError
  if (existingByKey?.id) {
    return { invoiceRequestId: String(existingByKey.id), created: false }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('invoice_requests')
    .insert({
      restaurant_id: restaurantId,
      order_id: orderId,
      payment_id: null,
      idempotency_key: idempotencyKey,
      source: 'checkout',
      status: 'pending',
      company_name: details.companyName,
      vat_number: details.vatNumber,
      email: details.email,
      metadata: details.metadata,
    })
    .select('id')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('invoice_requests')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()
      if (raced?.id) return { invoiceRequestId: String(raced.id), created: false }
    }
    throw insertError
  }

  const invoiceRequestId = String(inserted.id)

  await emitInvoiceRequested({
    event_id: randomUUID(),
    event_type: 'invoice.requested',
    occurred_at: new Date().toISOString(),
    restaurant_id: restaurantId,
    order_id: orderId,
    invoice_request_id: invoiceRequestId,
    source: 'checkout',
    is_resend: false,
  })

  return { invoiceRequestId, created: true }
}

/**
 * When a tab is marked ready-to-pay with invoice details, create pending
 * checkout invoice requests for each unpaid line-item order on the tab.
 */
export async function createPendingCheckoutInvoiceRequestsForTab(
  supabase: SupabaseClient,
  input: {
    tabId: string
    restaurantId: string
    details: InvoiceDetailsInput
  },
): Promise<{ createdCount: number; invoiceRequestIds: string[] }> {
  const tabId = String(input.tabId || '').trim()
  if (!tabId) return { createdCount: 0, invoiceRequestIds: [] }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id')
    .eq('tab_id', tabId)
    .eq('restaurant_id', input.restaurantId)
    .neq('payment_status', 'paid')
    .is('tab_settlement_for_tab_id', null)

  if (error) throw error

  const invoiceRequestIds: string[] = []
  let createdCount = 0

  for (const order of orders ?? []) {
    const result = await createPendingCheckoutInvoiceRequest(supabase, {
      orderId: String(order.id),
      restaurantId: input.restaurantId,
      details: input.details,
    })
    invoiceRequestIds.push(result.invoiceRequestId)
    if (result.created) createdCount += 1
  }

  return { createdCount, invoiceRequestIds }
}

/**
 * Attaches payment to a pending checkout invoice request and kicks off generation.
 */
export async function activatePendingInvoiceRequestOnPayment(
  supabase: SupabaseClient,
  input: {
    orderId: string
    restaurantId: string
    paymentId?: string | null
    paymentReference?: string | null
    skipGenerationSchedule?: boolean
    fallbackDetails?: InvoiceDetailsInput
  },
): Promise<void> {
  const orderId = String(input.orderId || '').trim()
  if (!orderId) return

  let pending = await findPendingCheckoutInvoiceRequest(supabase, orderId)

  if (!pending?.id && input.fallbackDetails) {
    await createPendingCheckoutInvoiceRequest(supabase, {
      orderId,
      restaurantId: input.restaurantId,
      details: input.fallbackDetails,
    })
    pending = await findPendingCheckoutInvoiceRequest(supabase, orderId)
  }

  if (!pending?.id) return

  const paymentId = input.paymentId ? String(input.paymentId).trim() : null

  if (paymentId) {
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, restaurant_id, order_ids')
      .eq('id', paymentId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) throw new CheckoutInvoiceRequestError('Payment not found', 404)
    if (String(payment.restaurant_id) !== String(input.restaurantId)) {
      throw new CheckoutInvoiceRequestError('Payment does not belong to this restaurant')
    }
    const orderIds = Array.isArray(payment.order_ids) ? payment.order_ids : []
    if (!orderIds.some((id) => String(id) === orderId)) {
      throw new CheckoutInvoiceRequestError('Payment is not linked to this order')
    }
  }

  const { data: activated, error: activateError } = await supabase
    .from('invoice_requests')
    .update({
      payment_id: paymentId,
      status: 'generating',
    })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (activateError) throw activateError
  if (!activated?.id) return

  if (!input.skipGenerationSchedule) {
    scheduleInvoiceGeneration(String(activated.id))
  }
}
