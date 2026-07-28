import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import { isClaimablePaymentStatus } from '@/lib/payments/payment-integrity'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { data: tables, error } = await supabase
      .from('restaurant_tables')
      .select(`
        id,
        table_number,
        status,
        tabs!inner(
          id,
          status,
          total,
          payment_preference,
          orders(
            id,
            order_number,
            total,
            status,
            payment_status,
            items,
            placed_at
          )
        )
      `)
      .eq('restaurant_id', terminal.restaurantId)
      .eq('status', 'occupied')
      .in('tabs.status', ['open', 'ready_to_pay'])
      .order('table_number', { ascending: true })

    if (error) {
      console.error('[terminal/tables GET]', error)
      return NextResponse.json({ error: 'Failed to load tables' }, { status: 500 })
    }

    const allOrderIds = (tables ?? []).flatMap((table: any) => {
      const tab = table.tabs?.[0] ?? null
      const orders = tab?.orders ?? []
      return orders.map((o: any) => String(o.id)).filter(Boolean)
    })

    const projections = await getPaymentProjections(
      supabase,
      terminal.restaurantId,
      allOrderIds,
    )

    // Compute canClose and unpaidTotal server-side
    const enriched = (tables ?? []).map((table: any) => {
      const tab = table.tabs?.[0] ?? null
      if (!tab) return { ...table, tab: null, canClose: false }

      const orders = (tab.orders ?? []).map((order: any) => {
        const projection = projections.get(String(order.id)) ?? null
        return {
          ...order,
          // Distinct from orders.payment_status (paid/pending settlement flag).
          payment_status_derived: projection?.paymentStatus ?? null,
          refunded_amount: projection?.refundedAmount ?? 0,
        }
      })
      // Only unpaid/pending orders still need settlement — cancelled (and any other
      // terminal, non-claimable) orders must not count toward unpaid/can_close.
      const unpaidOrders = orders.filter((o: any) =>
        isClaimablePaymentStatus(o.payment_status)
      )
      const unpaidTotal = unpaidOrders.reduce(
        (sum: number, o: any) => sum + Number(o.total), 0
      )
      const canClose = unpaidOrders.length === 0

      return {
        id: table.id,
        table_number: table.table_number,
        status: table.status,
        tab: {
          id: tab.id,
          status: tab.status,
          total: tab.total,
          unpaid_total: unpaidTotal,
          payment_preference: tab.payment_preference,
          orders,
        },
        can_close: canClose,
      }
    })

    return NextResponse.json({ tables: enriched })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
