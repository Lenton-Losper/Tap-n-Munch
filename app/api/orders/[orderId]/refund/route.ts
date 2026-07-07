import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { createRefund, RefundValidationError } from '@/lib/refunds/create-refund'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const trimmedOrderId = String(orderId || '').trim()

  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { data: existingOrder, error: loadError } = await supabase
    .from('orders')
    .select('id, restaurant_id')
    .eq('id', trimmedOrderId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }

  if (!existingOrder?.restaurant_id) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(
    String(existingOrder.restaurant_id),
    PERMISSIONS.ORDERS_REFUND,
    req,
  )
  if (isAuthError(auth)) return auth

  const body = await req.json().catch(() => null)
  const paymentId = body?.payment_id ?? body?.paymentId
  const amount = body?.amount
  const reason = body?.reason
  const refundMethod = body?.refund_method ?? body?.refundMethod
  const gatewayReference = body?.gateway_reference ?? body?.gatewayReference
  const requestId =
    body?.request_id ??
    body?.requestId ??
    req.headers.get('x-idempotency-key') ??
    req.headers.get('x-request-id')

  try {
    const result = await createRefund(auth.supabase, auth.userId, {
      orderId: trimmedOrderId,
      paymentId: String(paymentId || ''),
      amount,
      reason,
      refundMethod,
      gatewayReference,
      requestId: requestId != null ? String(requestId) : undefined,
    })

    if (result.alreadyProcessed) {
      return NextResponse.json({
        success: true,
        already_processed: true,
        message: 'Refund already processed',
        refund_id: result.refundId,
        amount: result.amount,
        refund_method: result.refundMethod,
        gateway_reference: result.gatewayReference,
        payment_amount: result.paymentAmount,
        total_refunded: result.totalRefunded,
        remaining_refundable: result.remainingRefundable,
      })
    }

    return NextResponse.json({
      success: true,
      already_processed: false,
      refund_id: result.refundId,
      amount: result.amount,
      refund_method: result.refundMethod,
      gateway_reference: result.gatewayReference,
      payment_amount: result.paymentAmount,
      total_refunded: result.totalRefunded,
      remaining_refundable: result.remainingRefundable,
    })
  } catch (error) {
    if (error instanceof RefundValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }

    const message = error instanceof Error ? error.message : 'Failed to process refund'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
