import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'

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
      .select('id, tab_id, restaurant_id, status, paycloud_merchant_order_no')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    let canClose = false

    if (status === 'success') {
      const paidAt = new Date().toISOString()
      // Voucher is distinct from Finatic merchant_order_no (paycloud_merchant_order_no).
      // payment_reference kept for backwards compatibility with older readers.
      const paymentVoucherNo = voucherNo || reference || null

      const updatePayload: Record<string, unknown> = {
        status: 'completed',
        payment_status: 'paid',
        payment_method: paymentMethod || 'card',
        payment_reference: reference,
        payment_voucher_no: paymentVoucherNo,
        paid_at: paidAt,
        completed_at: paidAt,
      }

      const { error: updateError } = await supabase
        .from('orders')
        .update(updatePayload)
        .eq('id', orderId)
        .eq('restaurant_id', terminal.restaurantId)

      if (updateError) {
        return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
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

      await safeIssueReceiptForOrder(orderId, 'terminal/payment')

      if (order.tab_id) {
        const { data: unpaidOrders } = await supabase
          .from('orders')
          .select('total')
          .eq('tab_id', order.tab_id)
          .neq('payment_status', 'paid')

        const newTotal = (unpaidOrders ?? []).reduce(
          (sum: number, o: any) => sum + Number(o.total),
          0,
        )

        await supabase.from('tabs').update({ total: newTotal }).eq('id', order.tab_id)

        const { data: remainingOrders } = await supabase
          .from('orders')
          .select('id')
          .eq('tab_id', order.tab_id)
          .neq('payment_status', 'paid')

        canClose = (remainingOrders ?? []).length === 0

        await supabase
          .from('tabs')
          .update({
            status: 'open',
            payment_preference: null,
            ready_to_pay_at: null,
          })
          .eq('id', order.tab_id)
      }

      const { error: auditError } = await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'payment.completed',
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          reference,
          voucherNo: paymentVoucherNo,
          businessOrderNo: businessOrderNo || order.paycloud_merchant_order_no || null,
          amount,
          paymentMethod,
          terminalId: terminal.terminalId,
        },
      })

      if (auditError) {
        console.error('[terminal/payment] audit log failed:', auditError)
      }
    } else {
      const { error: auditError } = await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'payment.failed',
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          reference,
          amount,
          terminalId: terminal.terminalId,
        },
      })

      if (auditError) {
        console.error('[terminal/payment] audit log failed:', auditError)
      }
    }

    return NextResponse.json({ success: true, canClose })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
