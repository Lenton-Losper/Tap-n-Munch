import { NextResponse } from 'next/server'
import { createPaymentRequest } from '@/payments/paycloud'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'
import { amountsMatch, PAYMENT_AMOUNT_TOLERANCE_CENTS, roundToCents } from '@/lib/payments/payment-integrity'
import {
  centsToMajor,
  projectOrderRows,
  type FinancialOrderInput,
  type OrderFinancials,
} from '@/lib/orders/order-financials'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const body = await req.json()
    const restaurantId = String(body.restaurantId || '').trim()
    const tableNumber = Number(body.tableNumber)
    const tabId = String(body.tabId ?? body.tab_id ?? '').trim()
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const sortedOrderIds = [...orderIds].sort()
    const clientAmount = Number(body.amount)

    if (!restaurantId || !Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid restaurant or table' }, { status: 400 })
    }
    if (orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No orders to pay' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', Number(tableNumber))
      .eq('is_closed', false)
      .order('placed_at', { ascending: true })

    const byId = new Map((orders || []).map((o: { id: string }) => [String(o.id), o]))

    const requiresSessionToken =
      Boolean(tabId) ||
      sortedOrderIds.some((orderId) => {
        const row = byId.get(orderId) as { tab_id?: string | null } | undefined
        return Boolean(row?.tab_id)
      })

    if (requiresSessionToken) {
      const guard = await requireSessionToken(req)
      if (guard.error) return guard.error
      const orderTabIds = sortedOrderIds
        .map((orderId) => {
          const row = byId.get(orderId) as { tab_id?: string | null } | undefined
          return String(row?.tab_id || '').trim()
        })
        .filter(Boolean)
      const boundTabId = String(tabId || orderTabIds[0] || '').trim()
      const mismatch = assertSessionMatchesResource(guard, {
        restaurantId: restaurantUuid,
        tabId: boundTabId || null,
      })
      if (mismatch) return mismatch
      if (
        orderTabIds.length > 0 &&
        orderTabIds.some((id) => id !== String(guard.tabId || '').trim())
      ) {
        return NextResponse.json(
          { ok: false, error: 'Session token does not match these orders' },
          { status: 403 },
        )
      }
    }

    for (const orderId of sortedOrderIds) {
      const data = byId.get(orderId) as Record<string, unknown> | undefined
      if (!data) {
        return NextResponse.json({ ok: false, error: `Order not found: ${orderId}` }, { status: 404 })
      }
      if (Number(data.table_number) !== tableNumber) {
        return NextResponse.json({ ok: false, error: 'Order does not match this table' }, { status: 400 })
      }
      if (data.is_closed === true) {
        return NextResponse.json({ ok: false, error: 'Cannot pay for a closed order' }, { status: 400 })
      }
      if (data.payment_status === 'paid') {
        console.log('[RECEIPT] Order already paid, blocking duplicate:', orderId)
        return NextResponse.json(
          {
            ok: false,
            error: 'This order has already been paid',
            code: 'ALREADY_PAID',
          },
          { status: 400 }
        )
      }
    }

    /**
     * WHAT IS STILL OWED, NOT orders.total.
     *
     * amend_order_lines never rewrites an order, so a voided line stays in `total`, and a
     * reduction's surviving quantity lives on a replacement order that the guest pays for as well.
     * Summing `total` charged the guest for food the waiter had cancelled. Each order's figure is its
     * OUTSTANDING amount from the one financial projection (lib/orders/order-financials.ts).
     *
     * FAILS CLOSED: nothing has been charged yet, so a refusal costs a retry.
     */
    let financials: Map<string, OrderFinancials>
    try {
      financials = await projectOrderRows(
        supabase,
        sortedOrderIds.map((id) => byId.get(id)) as unknown as FinancialOrderInput[],
      )
    } catch (e) {
      console.error('[RECEIPT] could not read what is still owed', e)
      return NextResponse.json(
        { ok: false, error: 'Could not work out what is still owed. Please try again.' },
        { status: 503 },
      )
    }
    const owedCents = (orderId: string) => financials.get(orderId)?.outstandingCents ?? 0

    /**
     * An order that owes nothing (every line voided, or already collected item by item) is left
     * out of the checkout rather than carried at zero: its expectation could not be recorded
     * (pending_charge_cents must be NULL or positive), and the gateway's figure must answer for
     * exactly the orders it pays.
     */
    const chargedOrderIds = sortedOrderIds.filter((id) => owedCents(id) > 0)
    const sumCents = chargedOrderIds.reduce((total, id) => total + owedCents(id), 0)
    if (sumCents <= 0) {
      return NextResponse.json(
        { ok: false, error: 'There is nothing left to pay on these orders.', code: 'NOTHING_LEFT_TO_CHARGE' },
        { status: 409 },
      )
    }
    const sum = centsToMajor(sumCents)

    /**
     * #223. This was `Math.abs(Math.round(sum*100)/100 - Math.round(clientAmount*100)/100) > 0.02`
     * -- raw floats, and a NaN passthrough: when `body.amount` was missing or unparseable,
     * `clientAmount` was `NaN`, `Math.abs(NaN - x)` is `NaN`, and `NaN > 0.02` is `false` -- so an
     * ABSENT client amount silently passed the check instead of being refused. amountsMatch
     * compares integer cents and explicitly returns false for a non-finite operand, closing both
     * at once. CLIENT leg (validating a client-submitted amount before the PayCloud checkout is
     * created, same shape as tabs/[tabId]/settle/route.ts's guard), so PAYMENT_AMOUNT_TOLERANCE_CENTS
     * applies, not the zero-tolerance gateway constant -- nothing has been charged yet here.
     */
    if (!amountsMatch(clientAmount, sum, PAYMENT_AMOUNT_TOLERANCE_CENTS)) {
      return NextResponse.json(
        { ok: false, error: 'Amount does not match order total. Please refresh and try again.' },
        { status: 400 }
      )
    }
    const roundedSum = roundToCents(sum)

    let merchantNo: string
    let storeNo: string
    try {
      const credentials = await getRestaurantFinaticCredentials(restaurantId)
      merchantNo = credentials.checkoutMerchantNo
      storeNo = credentials.checkoutStoreNo
      console.log('[RECEIPT] Using checkout credentials:', { merchantNo, storeNo })
    } catch {
      return NextResponse.json(
        {
          error: 'This restaurant has not configured their payment credentials. Please update settings.',
        },
        { status: 400 }
      )
    }

    let merchantOrderNo = ''
    for (const orderId of chargedOrderIds) {
      const row = byId.get(orderId) as { paycloud_merchant_order_no?: string | null; payment_reference?: string | null }
      const cand = String(row?.paycloud_merchant_order_no || row?.payment_reference || '').trim()
      if (cand) {
        merchantOrderNo = cand
        break
      }
    }
    if (!merchantOrderNo) {
      merchantOrderNo = `FT${Date.now()}`.slice(0, 32)
    }

    const leadId = chargedOrderIds[0]
    /**
     * THE EXPECTATION, RECORDED PER ORDER, BEFORE THE CHECKOUT EXISTS.
     *
     * The webhook and reconcile gates compare the gateway's figure against pending_charge_cents,
     * falling back to orders.total when none is recorded. Charging the outstanding figure without
     * recording it would make every amended order's successful payment a mismatch against its
     * stale total. Written on every charged order so the sum is exactly what was requested.
     */
    const leadPatch = {
      payment_status: 'pending' as const,
      payment_provider: 'paycloud' as const,
      payment_reference: merchantOrderNo,
      paycloud_merchant_order_no: merchantOrderNo,
    }
    const siblingPatch = {
      payment_status: 'pending' as const,
      payment_provider: 'paycloud' as const,
      payment_reference: merchantOrderNo,
      paycloud_merchant_order_no: null as string | null,
    }

    const leadRes = await supabase
      .from('orders')
      .update({ ...leadPatch, pending_charge_cents: owedCents(leadId) })
      .eq('id', leadId)
    if (leadRes.error) {
      console.error('[RECEIPT] Failed to persist merchant order (lead):', leadRes.error)
      return NextResponse.json({ ok: false, error: leadRes.error.message }, { status: 500 })
    }

    const siblingIds = chargedOrderIds.filter((id) => id !== leadId)
    if (siblingIds.length > 0) {
      const sibRes = await Promise.all(
        siblingIds.map((id) =>
          supabase
            .from('orders')
            .update({ ...siblingPatch, pending_charge_cents: owedCents(id) })
            .eq('id', id),
        )
      )
      const sibErr = sibRes.find((r) => r.error)
      if (sibErr?.error) {
        console.error('[RECEIPT] Failed to persist merchant order (siblings):', sibErr.error)
        return NextResponse.json({ ok: false, error: sibErr.error.message }, { status: 500 })
      }
    }

    // PayCloud checkout body field `expires` (seconds only, never ms/timestamp) is set in payments/paycloud.js.
    const payment = await createPaymentRequest({
      amount: roundedSum,
      orderId: merchantOrderNo,
      merchantNo,
      storeNo,
      description: `FlashTap receipt - Table ${tableNumber} (${chargedOrderIds.length} order${chargedOrderIds.length > 1 ? 's' : ''})`,
      checkoutReturnParams: {
        rid: restaurantId,
        table: String(tableNumber),
      },
    })

    // Same as /api/payments/create: createPaymentRequest returns or throws, never resolves
    // undefined. Reject rather than continue -- the orders are already marked pending above, and
    // a 201 with defaulted fields would tell the payer a checkout exists for money that was never
    // requested from the gateway. Throwing leaves them pending, which is what every other
    // provider failure on this route already does.
    if (!payment) {
      throw new Error('PayCloud returned no payment result')
    }

    if (payment.checkoutUrl) {
      await Promise.all(
        chargedOrderIds.map((id) =>
          supabase.from('orders').update({ payment_checkout_url: payment.checkoutUrl }).eq('id', id)
        )
      )
    }

    return NextResponse.json(
      {
        ok: true,
        paymentStatus: payment.paymentStatus,
        requires3ds: payment.requires3ds,
        checkoutUrl: payment.checkoutUrl,
        merchantOrderNo,
      },
      {
        status: 201,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment failed'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
