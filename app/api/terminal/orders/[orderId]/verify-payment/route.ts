import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { queryFinaticOrderPaid } from '@/lib/payments/query-finatic-order-paid'
import { amountsMatch } from '@/lib/payments/payment-integrity'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Terminal-auth Finatic status check for an order that already has
 * paycloud_merchant_order_no (from prepare-payment).
 *
 * When Finatic confirms paid=true, applies the correction immediately via the same
 * markOrderPaidConfirmed() used by the terminal's own success callback -- relying on
 * the terminal to separately call completePayment(success) afterward reproduces the
 * exact class of bug this route exists to catch (a device-side callback that never
 * arrives or misreports). Idempotent/safe if the terminal's own callback does still
 * land afterward: the second claim attempt just finds payment_status already 'paid'
 * and no-ops.
 *
 * Used when the device callback is missing, ambiguous, or reports failure after a
 * possible successful charge (false-failure / silence incidents).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, restaurant_id, payment_status, total, paycloud_merchant_order_no')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (orderError) {
      console.error('[terminal/verify-payment] load order failed', orderError)
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      return NextResponse.json({
        ok: true,
        paid: true,
        source: 'supabase',
        merchantOrderNo: order.paycloud_merchant_order_no
          ? String(order.paycloud_merchant_order_no)
          : null,
        transactionId: null,
        status: 'paid',
      })
    }

    const merchantOrderNo = String(order.paycloud_merchant_order_no || '').trim()
    if (!merchantOrderNo) {
      return NextResponse.json(
        {
          ok: true,
          paid: false,
          source: 'none',
          status: 'no_merchant_order',
          merchantOrderNo: null,
          transactionId: null,
          error: 'Order has no paycloud_merchant_order_no — prepare-payment was not completed',
        },
        { status: 200 },
      )
    }

    const { merchantNo, storeNo } = await getRestaurantFinaticCredentials(
      terminal.restaurantId,
    )

    const result = await queryFinaticOrderPaid({
      merchantOrderNo,
      merchantNo,
      storeNo,
    })

    console.log('[terminal/verify-payment]', {
      orderId,
      terminalId: terminal.terminalId,
      merchantOrderNo,
      paid: result.paid,
      status: result.status,
      transactionId: result.transactionId,
    })

    const expectedAmount = Number(order.total)
    let applied = false

    if (result.paid) {
      if (result.amount != null && !amountsMatch(result.amount, expectedAmount)) {
        console.error('[terminal/verify-payment] Finatic paid but amount mismatch — not applying', {
          orderId,
          merchantOrderNo,
          expectedAmount,
          finaticAmount: result.amount,
        })
      } else {
        const claim = await markOrderPaidConfirmed(supabase, {
          orderId,
          restaurantId: terminal.restaurantId,
          reference: merchantOrderNo,
          voucherNo: result.transactionId || merchantOrderNo,
          amount: expectedAmount,
          terminalId: terminal.terminalId,
          source: 'terminal_verify_payment',
        })
        applied = claim.claimed
      }
    }

    return NextResponse.json({
      ok: true,
      paid: result.paid,
      applied,
      source: 'finatic',
      merchantOrderNo: result.merchantOrderNo,
      transactionId: result.transactionId,
      status: result.status,
      amount: result.amount,
      expectedAmount,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Verify payment failed'
    console.error('[terminal/verify-payment]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
