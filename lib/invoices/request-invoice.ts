import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildCheckoutInvoiceIdempotencyKey,
  normalizeInvoiceDetails,
} from '@/lib/invoices/invoice-details'
import type { RequestInvoiceInput, RequestInvoiceResult } from '@/lib/invoices/types'
import { emitInvoiceRequested } from '@/lib/events/emit-invoice-requested'
import { scheduleInvoiceGeneration } from '@/lib/invoices/schedule-invoice-generation'

export class InvoiceRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'InvoiceRequestError'
    this.status = status
  }
}

function toResult(
  row: Record<string, unknown>,
  created: boolean,
  isResend: boolean,
): RequestInvoiceResult {
  return {
    invoiceRequestId: String(row.id),
    status: String(row.status),
    source: String(row.source) as RequestInvoiceResult['source'],
    created,
    isResend,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
  }
}

function maybeScheduleGeneration(invoiceRequestId: string, skip?: boolean) {
  if (!skip) {
    scheduleInvoiceGeneration(invoiceRequestId)
  }
}

export async function requestInvoice(
  supabase: SupabaseClient,
  input: RequestInvoiceInput,
): Promise<RequestInvoiceResult> {
  const orderId = String(input.orderId || '').trim()
  const source = input.source
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  const paymentId = input.paymentId ? String(input.paymentId).trim() : null

  if (!orderId) throw new InvoiceRequestError('order_id is required')
  if (!idempotencyKey) throw new InvoiceRequestError('idempotency_key is required')
  if (source === 'checkout') {
    throw new InvoiceRequestError(
      'Checkout invoices are captured at order placement; use activatePendingInvoiceRequestOnPayment after payment',
      400,
    )
  }

  const details = normalizeInvoiceDetails(input.details)

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, restaurant_id, payment_status')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) throw orderError
  if (!order?.restaurant_id) {
    throw new InvoiceRequestError('Order not found', 404)
  }

  if (String(order.payment_status || '').toLowerCase() !== 'paid') {
    throw new InvoiceRequestError('Invoices can only be requested for paid orders')
  }

  if (source === 'staff') {
    const { data: existingForOrder, error: existingOrderError } = await supabase
      .from('invoice_requests')
      .select('id, status, source, invoice_number')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingOrderError) throw existingOrderError
    if (existingForOrder) {
      const result = toResult(existingForOrder as Record<string, unknown>, false, true)
      await emitInvoiceRequested({
        event_id: randomUUID(),
        event_type: 'invoice.requested',
        occurred_at: new Date().toISOString(),
        restaurant_id: String(order.restaurant_id),
        order_id: orderId,
        invoice_request_id: result.invoiceRequestId,
        source: 'staff',
        is_resend: true,
      })
      maybeScheduleGeneration(result.invoiceRequestId, input.skipGenerationSchedule)
      return result
    }
  }

  const { data: existingByKey, error: existingKeyError } = await supabase
    .from('invoice_requests')
    .select('id, status, source, invoice_number')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (existingKeyError) throw existingKeyError
  if (existingByKey) {
    return toResult(existingByKey as Record<string, unknown>, false, source === 'staff')
  }

  if (paymentId) {
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, restaurant_id, order_ids')
      .eq('id', paymentId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) throw new InvoiceRequestError('Payment not found', 404)
    if (String(payment.restaurant_id) !== String(order.restaurant_id)) {
      throw new InvoiceRequestError('Payment does not belong to this order restaurant')
    }
    const orderIds = Array.isArray(payment.order_ids) ? payment.order_ids : []
    if (!orderIds.some((id) => String(id) === orderId)) {
      throw new InvoiceRequestError('Payment is not linked to this order')
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('invoice_requests')
    .insert({
      restaurant_id: order.restaurant_id,
      order_id: orderId,
      payment_id: paymentId,
      idempotency_key: idempotencyKey,
      source,
      status: 'pending',
      company_name: details.companyName,
      vat_number: details.vatNumber,
      email: details.email,
      metadata: details.metadata,
    })
    .select('id, status, source, invoice_number')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced, error: racedError } = await supabase
        .from('invoice_requests')
        .select('id, status, source, invoice_number')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()
      if (racedError) throw racedError
      if (raced) return toResult(raced as Record<string, unknown>, false, false)
    }
    throw insertError
  }

  const result = toResult(inserted as Record<string, unknown>, true, false)

  await emitInvoiceRequested({
    event_id: randomUUID(),
    event_type: 'invoice.requested',
    occurred_at: new Date().toISOString(),
    restaurant_id: String(order.restaurant_id),
    order_id: orderId,
    invoice_request_id: result.invoiceRequestId,
    source,
    is_resend: false,
  })

  maybeScheduleGeneration(result.invoiceRequestId, input.skipGenerationSchedule)

  return result
}

export { buildCheckoutInvoiceIdempotencyKey }
