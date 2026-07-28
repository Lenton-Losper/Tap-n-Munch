import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { amountsMatch } from '@/lib/payments/payment-integrity'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { handleTerminalPaymentFailed } from '@/lib/payments/handle-terminal-payment-failed'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    const body = await req.json().catch(() => ({}))
    const status = String(body?.status || '').trim()
    const reference = body?.reference != null ? String(body.reference).trim() : ''
    const voucherNo =
      body?.voucherNo != null && String(body.voucherNo).trim()
        ? String(body.voucherNo).trim()
        : ''
    const businessOrderNo =
      body?.businessOrderNo != null && String(body.businessOrderNo).trim()
        ? String(body.businessOrderNo).trim()
        : ''
    const amount = Number(body?.amount)
    const paymentMethod = body?.paymentMethod
      ? String(body.paymentMethod).trim()
      : 'card'

    if (status !== 'success' && status !== 'failed') {
      return NextResponse.json({ error: 'Invalid payment status' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, tab_id, restaurant_id, status, total, payment_status, paycloud_merchant_order_no',
      )
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    let canClose = false

    if (status === 'success') {
      const expectedAmount = Number(order.total)
      if (!amountsMatch(amount, expectedAmount)) {
        return NextResponse.json(
          {
            error: 'amount does not match order total',
            code: 'AMOUNT_MISMATCH',
            expected: expectedAmount,
            received: Number.isFinite(amount) ? amount : null,
          },
          { status: 400 },
        )
      }

      // Safety net: if prepare-payment was skipped (stale APK), persist merchant order now.
      if (businessOrderNo && !order.paycloud_merchant_order_no) {
        await supabase
          .from('orders')
          .update({ paycloud_merchant_order_no: businessOrderNo.slice(0, 32) })
          .eq('id', orderId)
          .eq('restaurant_id', terminal.restaurantId)
          .is('paycloud_merchant_order_no', null)
      }

      const result = await markOrderPaidConfirmed(supabase, {
        orderId,
        restaurantId: terminal.restaurantId,
        reference,
        voucherNo,
        paymentMethod: paymentMethod || 'card',
        amount: expectedAmount,
        terminalId: terminal.terminalId,
        source: 'terminal_callback',
        extraAuditMetadata: {
          businessOrderNo: businessOrderNo || order.paycloud_merchant_order_no || null,
        },
      })

      if (!result.claimed) {
        return NextResponse.json(
          {
            error: result.reason === 'already_paid' ? 'Order is already paid' : 'Order payment could not be claimed',
            code: result.reason === 'already_paid' ? 'ALREADY_PAID' : 'PAYMENT_CLAIM_CONFLICT',
          },
          { status: 409 },
        )
      }

      if (result.tabId) {
        const { data: remainingOrders } = await supabase
          .from('orders')
          .select('id')
          .eq('tab_id', result.tabId)
          .neq('payment_status', 'paid')

        canClose = (remainingOrders ?? []).length === 0

        await supabase
          .from('tabs')
          .update({
            status: 'open',
            payment_preference: null,
            ready_to_pay_at: null,
          })
          .eq('id', result.tabId)
      }
    } else {
      // Never trust a terminal failure report alone when Finatic may already have
      // charged (order #635). Same verify-before-cancel pattern as autoCancelStalePosOrders.
      let failedResult
      try {
        failedResult = await handleTerminalPaymentFailed(
          supabase,
          {
            orderId,
            restaurantId: terminal.restaurantId,
            orderTotal: Number(order.total),
            paycloudMerchantOrderNo: order.paycloud_merchant_order_no,
            terminalId: terminal.terminalId,
            reference,
            amount: Number.isFinite(amount) ? amount : undefined,
            paymentMethod: paymentMethod || 'card',
          },
          { stagingFinaticStub: body?.__stagingFinaticStub },
        )
      } catch (cancelErr: unknown) {
        const message = cancelErr instanceof Error ? cancelErr.message : 'Cancel failed'
        console.error('[terminal/payment] handleTerminalPaymentFailed error:', cancelErr)
        return NextResponse.json({ error: message }, { status: 500 })
      }

      if (failedResult.outcome === 'cancel_conflict') {
        return NextResponse.json(
          {
            error: 'Order payment could not be cancelled',
            code: 'PAYMENT_CANCEL_CONFLICT',
          },
          { status: 409 },
        )
      }

      if (failedResult.outcome === 'corrected_to_paid') {
        if (failedResult.tabId) {
          const { data: remainingOrders } = await supabase
            .from('orders')
            .select('id')
            .eq('tab_id', failedResult.tabId)
            .neq('payment_status', 'paid')

          canClose = (remainingOrders ?? []).length === 0

          await supabase
            .from('tabs')
            .update({
              status: 'open',
              payment_preference: null,
              ready_to_pay_at: null,
            })
            .eq('id', failedResult.tabId)
        }

        return NextResponse.json({
          success: true,
          canClose,
          outcome: 'corrected_to_paid',
        })
      }

      if (failedResult.outcome === 'left_pending_finatic_uncertain') {
        // Do not cancel; cron with verifyWithFinatic will resolve later.
        return NextResponse.json({
          success: true,
          canClose: false,
          outcome: 'left_pending_finatic_uncertain',
          reason: failedResult.reason,
        })
      }

      return NextResponse.json({
        success: true,
        canClose: false,
        outcome: 'cancelled',
      })
    }

    return NextResponse.json({ success: true, canClose })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
