import { NextResponse } from 'next/server'
import { findIntentByMerchantOrderNo } from '@/lib/payments/payment-intents'
import { isServerVerifiedLedgerRow } from '@/lib/payments/reconcile-reference'
import {
  checkSaleAmount,
  saleAmountMismatchAudit,
} from '@/lib/payments/reconcile-sale-amount'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { SECOND_PAYMENT_REFUSED_ACTION } from '@/lib/payments/record-refused-second-payment'
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
    // Another venue's intent is not what THIS venue's reader was asked for. Never compared against.
    if (intent && intent.restaurantId !== terminal.restaurantId) {
      console.error('[payment-events/sale] reference resolves to another venue\'s intent; ignored', {
        businessOrderNo,
      })
      intent = null
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

    /**
     * ============================================================================================
     * THIS ROW IS THE DEVICE'S REPORT, AND IT SAYS SO (Sprint 2026-09-29 brief, task 7)
     * ============================================================================================
     *
     * `amount` and `order_ids` below are what the DEVICE sent. The row used to be indistinguishable
     * from the ledger row settle_order_payment writes after verifying the gateway, and the orphan
     * cron treated its amount as the gateway's figure -- so a device reporting a manipulated amount
     * that happened to equal the named orders' totals got them marked paid with no gateway query.
     *
     * `origin = 'terminal_device'` marks every row this route writes as reported, not verified, and
     * `device_amount_check` records how the reported amount compared with what the server expected:
     * a mismatch is still RECORDED (refusing a real charge is worse, as above) but it can never be
     * read as an authoritative figure. The cron now verifies with Finatic before anything is paid;
     * see lib/payments/reconcile-orphan-payments.ts.
     */
    const deviceAmountCheck = amountCheck.matched
      ? amountCheck.basis === 'intent'
        ? 'matched_intent'
        : amountCheck.basis === 'order_totals'
          ? 'matched_order_totals'
          : 'unchecked'
      : amountCheck.basis === 'intent'
        ? 'mismatch_intent'
        : 'mismatch_order_totals'

    const insertPayload = {
      origin: 'terminal_device' as const,
      device_amount_check: deviceAmountCheck,
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

      /**
       * TWO READERS REPORTED A SALE ON ONE REFERENCE (RC-RACES, 2026-09-30, D4).
       *
       * One charge happens on one reader. A sale for this reference already reported by a
       * DIFFERENT terminal, with a different transaction id, is a second card charge -- the case the
       * FTOWN guard (20260930110000) prevents inside its window and cannot prevent after it (the
       * first reader answered late, after a second terminal took over). Returning the first row as
       * an idempotent replay recorded the second charge nowhere. It is written down as a probable
       * double charge for staff to refund, and refused. The device treats this call as
       * fire-and-forget, so a 409 changes nothing at the till.
       */
      const existingTerminal = String(existing.terminal_id ?? '').trim()
      const existingTxn = String(existing.transaction_id ?? '').trim()
      // Only a row a DEVICE reported carries that device's voucher: this route's own rows, and the
      // tab settle route's (it records the settling terminal's voucher). A row settle_order_payment
      // wrote holds the GATEWAY's transaction id, which need not match any voucher, so comparing
      // against it would raise a false double-charge alarm.
      const reportedByDevice =
        existing.origin === 'terminal_device' ||
        (existing.raw_gateway_response as { source?: unknown } | null)?.source === 'terminal/tabs/settle'
      if (
        reportedByDevice &&
        existingTerminal &&
        existingTerminal !== terminal.terminalId &&
        existingTxn &&
        existingTxn !== transactionId
      ) {
        const { error: auditError } = await supabase.from('audit_logs').insert({
          restaurant_id: terminal.restaurantId,
          action: SECOND_PAYMENT_REFUSED_ACTION,
          entity_type: 'payment_events',
          entity_id: String(existing.id),
          metadata: {
            source: 'terminal/payment-events/sale',
            reason: 'sale_reported_by_another_terminal',
            distinctGatewayTransaction: true,
            attemptedReference: businessOrderNo,
            attemptedTransactionId: transactionId,
            attemptedTerminalId: terminal.terminalId,
            attemptedAmount: amount,
            existingTransactionId: existingTxn,
            existingTerminalId: existingTerminal,
            order_ids: orderIds,
            note:
              'Two terminals reported a card sale on the same reference with different ' +
              'transactions. Only the first is recorded. The customer was very likely charged ' +
              'twice -- check the gateway and refund.',
            recordedAt: new Date().toISOString(),
          },
        })
        if (auditError) {
          console.error('[terminal/payment-events/sale] second-terminal sale audit failed', auditError)
        }
        console.error(
          `[SECOND-PAYMENT-REFUSED] PROBABLE DOUBLE CHARGE reference=${businessOrderNo} ` +
            `txn=${transactionId} terminal=${terminal.terminalId} first=${existingTxn}@${existingTerminal}`,
        )
        return NextResponse.json(
          {
            error:
              'Another terminal already recorded a card sale on this reference. This charge was ' +
              'not recorded; it has been flagged for a refund check.',
            code: 'SALE_REPORTED_BY_ANOTHER_TERMINAL',
          },
          { status: 409 },
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
      .select('business_order_no, amount, currency, order_ids, created_at, origin, device_amount_check, raw_gateway_response')
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

    /**
     * THE REFUND CAP IS A SERVER FIGURE, NEVER THE DEVICE'S WORD (Sprint 2026-09-29, task 7
     * follow-up). A device-reported row (origin='terminal_device') carries whatever amount the
     * device sent -- recorded even when it disagreed with the intent -- so capping refunds at it
     * would let a manipulated report authorise refunding more than was charged. The cap is:
     *   - a server-verified row's amount (the settlement RPC's ledger row, or a promoted row);
     *   - else, for a device row, the intent's amount_cents -- what the reader was asked for;
     *   - else a device row whose amount MATCHED the server's order totals when recorded;
     *   - anything else (a device mismatch / unchecked row with no intent) has no verified figure,
     *     and is refused rather than guessed.
     * Legacy rows (origin NULL, not server-written) predate the distinction and keep their amount.
     */
    let saleAmount: number
    let refundableBasis: 'verified_sale' | 'intent' | 'matched_order_totals' | 'legacy'
    if (isServerVerifiedLedgerRow(sale)) {
      saleAmount = Number(sale.amount)
      refundableBasis = 'verified_sale'
    } else if (sale.origin === 'terminal_device') {
      let saleIntent: Awaited<ReturnType<typeof findIntentByMerchantOrderNo>> = null
      try {
        saleIntent = await findIntentByMerchantOrderNo(supabase, originBusinessOrderNo)
      } catch {
        return NextResponse.json({ error: 'Failed to look up the payment intent' }, { status: 500 })
      }
      if (saleIntent && saleIntent.restaurantId === terminal.restaurantId) {
        saleAmount = saleIntent.amountCents / 100
        refundableBasis = 'intent'
      } else if (sale.device_amount_check === 'matched_order_totals' || sale.device_amount_check === 'matched_intent') {
        saleAmount = Number(sale.amount)
        refundableBasis = 'matched_order_totals'
      } else {
        return NextResponse.json(
          {
            code: 'SALE_AMOUNT_UNVERIFIED',
            error:
              'This sale was reported by the device for an amount the server could not verify; ' +
              'reconcile it against the gateway before refunding.',
            business_order_no: originBusinessOrderNo,
          },
          { status: 409 },
        )
      }
    } else {
      saleAmount = Number(sale.amount)
      refundableBasis = 'legacy'
    }
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
      // Additive: which rule produced `amount` / `remaining`.
      refundable_basis: refundableBasis,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/payment-events/sale]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
