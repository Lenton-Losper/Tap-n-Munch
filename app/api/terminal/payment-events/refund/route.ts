import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'

export const dynamic = 'force-dynamic'

const REASON_CODES = [
  'wrong_item',
  'quality_issue',
  'duplicate_charge',
  'customer_request',
  'other',
] as const

type ReasonCode = (typeof REASON_CODES)[number]
type GatewayResult = 'success' | 'failure'

type RefundBody = {
  token_id?: unknown
  user_id?: unknown
  origin_business_order_no?: unknown
  order_ids?: unknown
  business_order_no?: unknown
  amount?: unknown
  reason_code?: unknown
  reason_note?: unknown
  gateway_result?: unknown
  transaction_id?: unknown
  gateway_result_code?: unknown
  gateway_result_message?: unknown
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value)
}

function isGatewayResult(value: string): value is GatewayResult {
  return value === 'success' || value === 'failure'
}

function parseRpcError(message: string): {
  status: number
  body: Record<string, unknown>
} | null {
  if (message.includes('SALE_NOT_FOUND')) {
    return {
      status: 400,
      body: { error: 'Original SALE not found for origin_business_order_no' },
    }
  }
  if (message.includes('AMOUNT_EXCEEDS_REMAINING')) {
    const parts = message.split('AMOUNT_EXCEEDS_REMAINING:')
    const nums = (parts[1] ?? '').split(':').map((p) => Number(p))
    return {
      status: 400,
      body: {
        error: 'amount exceeds remaining refundable balance',
        code: 'AMOUNT_EXCEEDS_REMAINING',
        sale_amount: Number.isFinite(nums[0]) ? nums[0] : null,
        prior_refunded: Number.isFinite(nums[1]) ? nums[1] : null,
        remaining: Number.isFinite(nums[2]) ? nums[2] : null,
      },
    }
  }
  if (message.includes('INVALID_AMOUNT') || message.includes('INVALID_EVENT_TYPE')) {
    return { status: 400, body: { error: 'Invalid refund payload' } }
  }
  return null
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as RefundBody

    const tokenId = String(body.token_id ?? '').trim()
    const userId = String(body.user_id ?? '').trim()
    if (!tokenId || !isUuid(tokenId)) {
      return NextResponse.json({ error: 'token_id must be a valid UUID' }, { status: 400 })
    }
    if (!userId || !isUuid(userId)) {
      return NextResponse.json({ error: 'user_id must be a valid UUID' }, { status: 400 })
    }

    const originBusinessOrderNo = String(body.origin_business_order_no ?? '').trim()
    if (!originBusinessOrderNo) {
      return NextResponse.json(
        { error: 'origin_business_order_no must be a non-empty string' },
        { status: 400 },
      )
    }

    if (!Array.isArray(body.order_ids) || body.order_ids.length === 0) {
      return NextResponse.json(
        { error: 'order_ids must be a non-empty array' },
        { status: 400 },
      )
    }
    const orderIds = body.order_ids.map((id) => String(id).trim())
    const invalidUuidOrderIds = orderIds.filter((id) => !isUuid(id))
    if (invalidUuidOrderIds.length > 0) {
      return NextResponse.json(
        { error: 'Invalid order_ids', invalid_order_ids: invalidUuidOrderIds },
        { status: 400 },
      )
    }

    const businessOrderNo = String(body.business_order_no ?? '').trim()
    if (!businessOrderNo) {
      return NextResponse.json(
        { error: 'business_order_no must be a non-empty string' },
        { status: 400 },
      )
    }
    if (businessOrderNo === originBusinessOrderNo) {
      return NextResponse.json(
        {
          error:
            'business_order_no must be a new refund number, not equal to origin_business_order_no',
        },
        { status: 400 },
      )
    }

    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a finite number greater than 0' },
        { status: 400 },
      )
    }

    const reasonCode = String(body.reason_code ?? '').trim()
    if (!isReasonCode(reasonCode)) {
      return NextResponse.json(
        {
          error:
            'reason_code must be one of: wrong_item, quality_issue, duplicate_charge, customer_request, other',
        },
        { status: 400 },
      )
    }

    const gatewayResultRaw = String(body.gateway_result ?? '').trim()
    if (!isGatewayResult(gatewayResultRaw)) {
      return NextResponse.json(
        { error: "gateway_result must be 'success' or 'failure'" },
        { status: 400 },
      )
    }
    const gatewayResult = gatewayResultRaw

    const reasonNote =
      body.reason_note != null && String(body.reason_note).trim()
        ? String(body.reason_note).trim()
        : null
    const transactionId =
      body.transaction_id != null && String(body.transaction_id).trim()
        ? String(body.transaction_id).trim()
        : null
    const gatewayResultCode =
      body.gateway_result_code != null && String(body.gateway_result_code).trim()
        ? String(body.gateway_result_code).trim()
        : null
    const gatewayResultMessage =
      body.gateway_result_message != null && String(body.gateway_result_message).trim()
        ? String(body.gateway_result_message).trim()
        : null

    const { data: existingRefund, error: existingError } = await supabase
      .from('payment_events')
      .select('*')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('idempotency_key', businessOrderNo)
      .maybeSingle()

    if (existingError) {
      return NextResponse.json(
        { error: 'Failed to check existing payment event' },
        { status: 500 },
      )
    }
    if (existingRefund) {
      return NextResponse.json(existingRefund)
    }

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id')
      .in('id', orderIds)
      .eq('restaurant_id', terminal.restaurantId)

    if (ordersError) {
      return NextResponse.json({ error: 'Failed to validate order_ids' }, { status: 500 })
    }

    const foundOrderIds = new Set((orders ?? []).map((order) => String(order.id)))
    const invalidOrderIds = orderIds.filter((id) => !foundOrderIds.has(id))
    if (invalidOrderIds.length > 0) {
      return NextResponse.json(
        { error: 'Invalid order_ids', invalid_order_ids: invalidOrderIds },
        { status: 400 },
      )
    }

    const { data: originalSale, error: saleError } = await supabase
      .from('payment_events')
      .select('id, currency')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('event_type', 'sale')
      .eq('business_order_no', originBusinessOrderNo)
      .maybeSingle()

    if (saleError) {
      return NextResponse.json({ error: 'Failed to look up original SALE' }, { status: 500 })
    }
    if (!originalSale) {
      return NextResponse.json(
        { error: 'Original SALE not found for origin_business_order_no' },
        { status: 400 },
      )
    }

    const consume = await consumeAuthorizationToken(supabase, {
      tokenId,
      expectedUserId: userId,
      expectedRestaurantId: terminal.restaurantId,
      expectedTerminalId: terminal.terminalId,
      expectedPurpose: 'refund',
    })
    if (!consume.ok) {
      return NextResponse.json(
        { error: 'Authorization token rejected', reason: consume.reason },
        { status: 403 },
      )
    }

    const eventType =
      gatewayResult === 'success' ? ('refund_succeeded' as const) : ('refund_failed' as const)

    const { data: created, error: rpcError } = await supabase.rpc(
      'record_terminal_refund_event',
      {
        p_restaurant_id: terminal.restaurantId,
        p_order_ids: orderIds,
        p_event_type: eventType,
        p_business_order_no: businessOrderNo,
        p_origin_business_order_no: originBusinessOrderNo,
        p_transaction_id: transactionId,
        p_terminal_id: terminal.terminalId,
        p_amount: amount,
        p_currency: String(originalSale.currency || 'NAD'),
        p_idempotency_key: businessOrderNo,
        p_initiated_by: userId,
        p_reason_code: reasonCode,
        p_reason_note: reasonNote,
        p_gateway_result_code: gatewayResultCode,
        p_gateway_result_message: gatewayResultMessage,
      },
    )

    if (rpcError || !created) {
      const parsed = parseRpcError(String(rpcError?.message ?? ''))
      if (parsed) {
        return NextResponse.json(parsed.body, { status: parsed.status })
      }
      console.error('[terminal/payment-events/refund] rpc failed:', rpcError)
      return NextResponse.json({ error: 'Failed to record refund event' }, { status: 500 })
    }

    return NextResponse.json(created)
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/payment-events/refund]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
