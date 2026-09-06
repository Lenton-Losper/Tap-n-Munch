import { NextResponse } from 'next/server'
import { findIntentByMerchantOrderNo } from '@/lib/payments/payment-intents'
import {
  checkSaleAmount,
  saleAmountMismatchAudit,
} from '@/lib/payments/reconcile-sale-amount'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'

export const dynamic = 'force-dynamic'

/**
 * Runs `promise` in the background without making the caller wait for it. The promise
 * starts executing immediately either way; when running as a real Cloudflare Worker we
 * additionally register it with ctx.waitUntil so it's guaranteed to finish before the
 * isolate is torn down after the response is sent. Falls back to a plain unawaited
 * promise when there's no Workers context (e.g. local `next dev`, where the process
 * stays alive independent of the response).
 */
function runInBackground(promise: Promise<unknown>): void {
  const guarded = promise.catch((error) => console.error('[terminal/payment-events/sale] background task failed', error))

  import('@opennextjs/cloudflare')
    .then(({ getCloudflareContext }) => {
      const { ctx } = getCloudflareContext()
      ctx.waitUntil(guarded)
    })
    .catch(() => {
      // Not running in a Cloudflare Workers context -- `guarded` is already running
      // unawaited above, which is sufficient there.
    })
}

/** No delivery mechanism exists yet (Phase 2-4) -- issuance failure must never affect the payment response. */
function issueReceiptsForOrders(orderIds: string[]): void {
  for (const orderId of orderIds) {
    runInBackground(
      issueReceiptForOrder(orderId).catch((error) => {
        console.error(`[terminal/payment-events/sale] receipt issuance failed for order ${orderId}:`, error)
      }),
    )
  }
}

type SaleBody = {
  order_ids?: unknown
  business_order_no?: unknown
  transaction_id?: unknown
  amount?: unknown
  currency?: unknown
  app_version?: unknown
  gateway_result_code?: unknown
  gateway_result_message?: unknown
  raw_gateway_response?: unknown
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' || Boolean(error?.message?.includes('duplicate key'))
}

function orderIdSetsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const id of setA) {
    if (!setB.has(id)) return false
  }
  return true
}

function amountsEqual(a: unknown, b: number): boolean {
  return Number(a) === b
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as SaleBody

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

    const transactionId = String(body.transaction_id ?? '').trim()
    if (!transactionId) {
      return NextResponse.json(
        { error: 'transaction_id must be a non-empty string' },
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

    const currency =
      body.currency != null && String(body.currency).trim()
        ? String(body.currency).trim()
        : 'NAD'
    const appVersion =
      body.app_version != null && String(body.app_version).trim()
        ? String(body.app_version).trim()
        : null
    const gatewayResultCode =
      body.gateway_result_code != null && String(body.gateway_result_code).trim()
        ? String(body.gateway_result_code).trim()
        : null
    const gatewayResultMessage =
      body.gateway_result_message != null && String(body.gateway_result_message).trim()
        ? String(body.gateway_result_message).trim()
        : null
    const rawGatewayResponse =
      body.raw_gateway_response != null && typeof body.raw_gateway_response === 'object'
        ? body.raw_gateway_response
        : null

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      // `total` is new here: the amount was previously compared against nothing at all.
      .select('id, total')
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

    /**
     * ============================================================================================
     * DID THE GATEWAY CHARGE WHAT WE ASKED FOR?
     * ============================================================================================
     *
     * This route used to accept one `amount` against N orders and compare it to nothing. It is
     * compared now — against the INTENT where the charge has one (what the reader was asked for,
     * the only honest figure), and against the sum of the named orders' totals otherwise.
     *
     * NOTHING IS REFUSED. This runs AFTER the money has moved: refusing to record a real charge
     * would leave a customer charged and the system unaware, which is strictly worse than a
     * flagged row. A mismatch is written to audit_logs against every named order and the event is
     * recorded exactly as before.
     *
     * A FAILED INTENT LOOKUP DOES NOT BLOCK THE RECORD EITHER, for the same reason — but it is not
     * silently treated as "no intent", because that would downgrade an exact check to an advisory
     * one without saying so. It is logged and the basis falls back honestly.
     */
    let intent: Awaited<ReturnType<typeof findIntentByMerchantOrderNo>> = null
    try {
      intent = await findIntentByMerchantOrderNo(supabase, businessOrderNo)
    } catch (intentError) {
      console.error('[payment-events/sale] intent lookup failed; amount check falls back', {
        businessOrderNo,
        error: intentError instanceof Error ? intentError.message : String(intentError),
      })
    }

    const amountCheck = checkSaleAmount({
      amount,
      intent,
      orderTotals: (orders ?? []).map((o) => Number((o as { total?: unknown }).total ?? 0)),
    })

    if (!amountCheck.matched) {
      console.error('[payment-events/sale] amount does not match what was expected', {
        businessOrderNo,
        basis: amountCheck.basis,
        gatewayAmount: amountCheck.gatewayAmount,
        expectedAmount: amountCheck.expectedAmount,
        advisory: amountCheck.advisory,
      })
      const { error: mismatchAuditError } = await supabase.from('audit_logs').insert(
        orderIds.map((orderId) =>
          saleAmountMismatchAudit({
            restaurantId: terminal.restaurantId,
            orderId,
            businessOrderNo,
            check: amountCheck,
          }),
        ),
      )
      // The audit is the record a human works from, so a failure to write it must not vanish —
      // but it still does not block the payment being recorded.
      if (mismatchAuditError) {
        console.error('[payment-events/sale] mismatch audit insert failed', {
          businessOrderNo,
          error: mismatchAuditError.message,
        })
      }
    }

    const insertPayload = {
      restaurant_id: terminal.restaurantId,
      order_ids: orderIds,
      event_type: 'sale' as const,
      business_order_no: businessOrderNo,
      origin_business_order_no: businessOrderNo,
      transaction_id: transactionId,
      terminal_id: terminal.terminalId,
      app_version: appVersion,
      amount,
      currency,
      initiated_by: null,
      idempotency_key: businessOrderNo,
      reason_code: 'sale',
      gateway_result_code: gatewayResultCode,
      gateway_result_message: gatewayResultMessage,
      raw_gateway_response: rawGatewayResponse,
    }

    const { data: created, error: insertError } = await supabase
      .from('payment_events')
      .insert(insertPayload)
      .select('*')
      .single()

    if (!insertError && created) {
      issueReceiptsForOrders(orderIds)
      return NextResponse.json(created)
    }

    if (isUniqueViolation(insertError)) {
      const { data: existing, error: existingError } = await supabase
        .from('payment_events')
        .select('*')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('idempotency_key', businessOrderNo)
        .single()

      if (existingError || !existing) {
        return NextResponse.json(
          { error: 'Failed to load existing payment event' },
          { status: 500 },
        )
      }

      const existingOrderIds = Array.isArray(existing.order_ids)
        ? existing.order_ids.map((id: unknown) => String(id))
        : []
      const orderIdsMatch = orderIdSetsEqual(existingOrderIds, orderIds)
      const amountMatch = amountsEqual(existing.amount, amount)

      if (!orderIdsMatch || !amountMatch) {
        console.error(
          '[terminal/payment-events/sale] business_order_no conflict: existing row differs from retry payload',
          {
            business_order_no: businessOrderNo,
            restaurant_id: terminal.restaurantId,
            existing: { order_ids: existingOrderIds, amount: existing.amount },
            incoming: { order_ids: orderIds, amount },
          },
        )
        return NextResponse.json(
          {
            error: 'business_order_no already recorded with different order_ids/amount',
          },
          { status: 409 },
        )
      }

      issueReceiptsForOrders(orderIds)
      return NextResponse.json(existing)
    }

    console.error('[terminal/payment-events/sale] insert failed:', insertError)
    return NextResponse.json({ error: 'Failed to record payment event' }, { status: 500 })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/payment-events/sale]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const url = new URL(req.url)
    const orderId = String(url.searchParams.get('order_id') ?? '').trim()
    if (!orderId) {
      return NextResponse.json({ error: 'order_id is required' }, { status: 400 })
    }
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'order_id must be a valid UUID' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (orderError) {
      return NextResponse.json({ error: 'Failed to validate order_id' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json(
        { error: 'Invalid order_id', invalid_order_ids: [orderId] },
        { status: 400 },
      )
    }

    const { data: sales, error: saleError } = await supabase
      .from('payment_events')
      .select('business_order_no, amount, currency, order_ids, created_at')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('event_type', 'sale')
      .contains('order_ids', [orderId])
      .order('created_at', { ascending: false })
      .limit(1)

    if (saleError) {
      return NextResponse.json({ error: 'Failed to look up sale record' }, { status: 500 })
    }

    const sale = sales?.[0]
    if (!sale) {
      return NextResponse.json(
        { error: 'No sale record found for this order' },
        { status: 404 },
      )
    }

    const originBusinessOrderNo = String(sale.business_order_no)
    const { data: priorRefunds, error: priorError } = await supabase
      .from('payment_events')
      .select('amount')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('event_type', 'refund_succeeded')
      .eq('origin_business_order_no', originBusinessOrderNo)

    if (priorError) {
      return NextResponse.json(
        { error: 'Failed to compute refunded balance' },
        { status: 500 },
      )
    }

    const saleAmount = Number(sale.amount)
    const refundedSoFar = (priorRefunds ?? []).reduce(
      (sum, row) => sum + Number(row.amount),
      0,
    )

    return NextResponse.json({
      business_order_no: originBusinessOrderNo,
      amount: saleAmount,
      currency: String(sale.currency || 'NAD'),
      order_ids: Array.isArray(sale.order_ids)
        ? sale.order_ids.map((id: unknown) => String(id))
        : [],
      refunded_so_far: refundedSoFar,
      remaining: saleAmount - refundedSoFar,
      sale_recorded_at: sale.created_at,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/payment-events/sale]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
