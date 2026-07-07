import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveStaffMemberId } from '@/lib/permissions/authorize'
import type { CreateRefundInput, CreateRefundResult, RefundMethod } from '@/lib/refunds/refund-types'

export class RefundValidationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RefundValidationError'
    this.status = status
  }
}

export function buildCashRefundIdempotencyKey(paymentId: string, requestId: string): string {
  return `refund:${paymentId}:${requestId}`
}

export function buildCardRefundIdempotencyKey(paymentId: string, gatewayReference: string): string {
  return `refund:${paymentId}:${gatewayReference}`
}

/** @deprecated Use buildCashRefundIdempotencyKey or buildCardRefundIdempotencyKey */
export function buildRefundIdempotencyKey(paymentId: string, requestId: string): string {
  return buildCashRefundIdempotencyKey(paymentId, requestId)
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function parseAmount(raw: unknown): number {
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RefundValidationError('amount must be a positive number')
  }
  return roundMoney(amount)
}

function parseRefundMethod(raw: unknown): RefundMethod {
  const method = String(raw ?? 'cash').trim().toLowerCase()
  if (method === 'card' || method === 'cash') return method
  throw new RefundValidationError("refund_method must be 'cash' or 'card'")
}

function paymentIncludesOrder(orderIds: unknown, orderId: string): boolean {
  if (!Array.isArray(orderIds)) return false
  return orderIds.some((id) => String(id) === orderId)
}

async function sumCompletedRefunds(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('refund_events')
    .select('amount')
    .eq('payment_id', paymentId)
    .eq('status', 'completed')

  if (error) throw error

  return roundMoney(
    (data ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
  )
}

function toResult(input: {
  refund: {
    id: string
    order_id: string
    payment_id: string
    amount: number | string
    reason: string | null
    refund_method?: string | null
    gateway_reference?: string | null
  }
  paymentAmount: number
  totalRefunded: number
  alreadyProcessed: boolean
}): CreateRefundResult {
  const paymentAmount = roundMoney(input.paymentAmount)
  const totalRefunded = roundMoney(input.totalRefunded)

  return {
    refundId: String(input.refund.id),
    orderId: String(input.refund.order_id),
    paymentId: String(input.refund.payment_id),
    amount: roundMoney(Number(input.refund.amount)),
    reason: input.refund.reason,
    refundMethod: (input.refund.refund_method === 'card' ? 'card' : 'cash') as RefundMethod,
    gatewayReference: input.refund.gateway_reference ? String(input.refund.gateway_reference) : null,
    paymentAmount,
    totalRefunded,
    remainingRefundable: roundMoney(Math.max(0, paymentAmount - totalRefunded)),
    alreadyProcessed: input.alreadyProcessed,
  }
}

export async function createRefund(
  supabase: SupabaseClient,
  userId: string,
  input: CreateRefundInput,
): Promise<CreateRefundResult> {
  const orderId = String(input.orderId || '').trim()
  const paymentId = String(input.paymentId || '').trim()
  const reason = String(input.reason || '').trim() || null
  const amount = parseAmount(input.amount)
  const refundMethod = parseRefundMethod(input.refundMethod)

  if (!orderId) throw new RefundValidationError('order_id is required')
  if (!paymentId) throw new RefundValidationError('payment_id is required')

  let idempotencyKey: string
  let gatewayReference: string | null = null

  if (refundMethod === 'card') {
    gatewayReference = String(input.gatewayReference ?? '').trim()
    if (!gatewayReference) {
      throw new RefundValidationError('gateway_reference is required for card refunds')
    }
    idempotencyKey = buildCardRefundIdempotencyKey(paymentId, gatewayReference)
  } else {
    const requestId = String(input.requestId || '').trim()
    if (!requestId) {
      throw new RefundValidationError('request_id is required for cash refunds')
    }
    const gatewayRaw = input.gatewayReference
    if (gatewayRaw != null && String(gatewayRaw).trim() !== '') {
      throw new RefundValidationError('gateway_reference must not be provided for cash refunds')
    }
    idempotencyKey = buildCashRefundIdempotencyKey(paymentId, requestId)
  }

  const { data: existingRefund, error: existingError } = await supabase
    .from('refund_events')
    .select('id, order_id, payment_id, amount, reason, refund_method, gateway_reference')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (existingError) throw existingError

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, restaurant_id')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) throw orderError
  if (!order?.restaurant_id) {
    throw new RefundValidationError('Order not found', 404)
  }

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, restaurant_id, amount, order_ids, status')
    .eq('id', paymentId)
    .maybeSingle()

  if (paymentError) throw paymentError
  if (!payment?.restaurant_id) {
    throw new RefundValidationError('Payment not found', 404)
  }

  if (String(payment.restaurant_id) !== String(order.restaurant_id)) {
    throw new RefundValidationError('Payment does not belong to this order restaurant', 400)
  }

  if (!paymentIncludesOrder(payment.order_ids, orderId)) {
    throw new RefundValidationError('Payment is not linked to this order', 400)
  }

  const paymentAmount = roundMoney(Number(payment.amount))
  if (paymentAmount <= 0) {
    throw new RefundValidationError('Payment has no refundable amount', 400)
  }

  const totalRefunded = await sumCompletedRefunds(supabase, paymentId)

  if (existingRefund) {
    return toResult({
      refund: existingRefund,
      paymentAmount,
      totalRefunded,
      alreadyProcessed: true,
    })
  }

  if (totalRefunded + amount > paymentAmount) {
    throw new RefundValidationError(
      `Refund amount exceeds remaining refundable balance (${roundMoney(paymentAmount - totalRefunded)} remaining)`,
    )
  }

  const refundedBy = await resolveStaffMemberId(userId, String(order.restaurant_id))
  if (!refundedBy) {
    throw new RefundValidationError('Staff member record not found for this account', 403)
  }

  const { data: inserted, error: insertError } = await supabase
    .from('refund_events')
    .insert({
      restaurant_id: order.restaurant_id,
      order_id: orderId,
      payment_id: paymentId,
      amount,
      reason,
      refunded_by: refundedBy,
      idempotency_key: idempotencyKey,
      status: 'completed',
      refund_method: refundMethod,
      gateway_reference: gatewayReference,
    })
    .select('id, order_id, payment_id, amount, reason, refund_method, gateway_reference')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: racedRefund, error: racedError } = await supabase
        .from('refund_events')
        .select('id, order_id, payment_id, amount, reason, refund_method, gateway_reference')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()

      if (racedError) throw racedError
      if (racedRefund) {
        return toResult({
          refund: racedRefund,
          paymentAmount,
          totalRefunded,
          alreadyProcessed: true,
        })
      }
    }
    throw insertError
  }

  const newTotalRefunded = roundMoney(totalRefunded + amount)

  return toResult({
    refund: inserted,
    paymentAmount,
    totalRefunded: newTotalRefunded,
    alreadyProcessed: false,
  })
}
