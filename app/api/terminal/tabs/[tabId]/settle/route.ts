import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { generatePaymentReference } from '@/lib/payment-reference'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params
    const body = await req.json().catch(() => ({}))

    const orderIds: string[] = body.order_ids ?? []
    const gatewayReference: string = body.gateway_reference ?? ''
    const amount: number = Number(body.amount)
    const method: string = body.method ?? 'card'

    if (!orderIds.length) {
      return NextResponse.json(
        { error: 'order_ids required' },
        { status: 400 }
      )
    }

    // Verify tab belongs to this restaurant
    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, table_id, total')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (tabError || !tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    const paidAt = new Date().toISOString()
    const paymentReference = generatePaymentReference()

    // Mark selected orders as paid
    const { error: ordersError } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method: method,
        payment_reference: paymentReference,
        status: 'completed',
        paid_at: paidAt,
        completed_at: paidAt,
      })
      .in('id', orderIds)
      .eq('restaurant_id', terminal.restaurantId)

    if (ordersError) {
      return NextResponse.json(
        { error: 'Failed to update orders' },
        { status: 500 }
      )
    }

    // Recalculate tab total from remaining unpaid orders
    const { data: unpaidOrders } = await supabase
      .from('orders')
      .select('total')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')

    const newTotal = (unpaidOrders ?? []).reduce(
      (sum, o) => sum + Number(o.total), 0
    )

    await supabase
      .from('tabs')
      .update({ total: newTotal })
      .eq('id', tabId)

    // Create payment record
    await supabase.from('payments').insert({
      restaurant_id: terminal.restaurantId,
      table_id: tab.table_id,
      tab_id: tabId,
      order_ids: orderIds,
      amount,
      method,
      status: 'completed',
      gateway_reference: gatewayReference,
      payment_reference: paymentReference,
      completed_at: paidAt,
    })

    // Audit log
    await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: 'payment.tab_settled',
      entity_type: 'tabs',
      entity_id: tabId,
      metadata: {
        order_ids: orderIds,
        amount,
        method,
        payment_reference: paymentReference,
        terminal_id: terminal.terminalId,
      },
    })

    // canClose check
    const { data: remaining } = await supabase
      .from('orders')
      .select('id')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')

    const canClose = (remaining ?? []).length === 0

    await supabase
      .from('tabs')
      .update({
        status: 'open',
        payment_preference: null,
        ready_to_pay_at: null,
      })
      .eq('id', tabId)

    return NextResponse.json({
      success: true,
      payment_reference: paymentReference,
      new_tab_total: newTotal,
      can_close: canClose,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
