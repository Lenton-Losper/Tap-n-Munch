import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope } from '@/lib/supabase/restaurants'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { createOrder } from '@/lib/orders/create-order'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json(
        { error: 'Missing permission: orders:read' },
        { status: 403 }
      )
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', terminal.restaurantId)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
      .order('placed_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 })
    }

    return NextResponse.json({ orders: data })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const terminal = await requireTerminalAuth(request)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const body = await request.json()
    const { restaurantId, items, subtotal, total, orderInstructions } = body

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }
    if (String(restaurantId).trim() !== terminal.restaurantId) {
      return NextResponse.json(
        { error: 'restaurantId does not match terminal' },
        { status: 403 }
      )
    }
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items are required' }, { status: 400 })
    }
    if (!total || total <= 0) {
      return NextResponse.json({ error: 'total must be greater than 0' }, { status: 400 })
    }

    const orderRestaurantScope = await resolveOrderRestaurantScope(terminal.restaurantId)

    const enrichedItems = await enrichOrderItemsWithRouteTo(supabase, items)

    const result = await createOrder({
      restaurantId: orderRestaurantScope.restaurantId,
      firebaseRestaurantId: orderRestaurantScope.firebaseRestaurantId,
      tableNumber: 0,
      tableId: null,
      sessionId: null,
      memberSessionId: null,
      items: enrichedItems,
      subtotal: Number(subtotal) || 0,
      total: Number(total),
      paymentMethod: 'card',
      paymentChannel: 'card_manual',
      paymentStatus: 'pending',
      orderInstructions: orderInstructions || null,
      tabId: null,
      tabSettlementForTabId: null,
      channel: 'pos',
      customerName: null,
      idempotencyKey: request.headers.get('x-idempotency-key') || null,
    })

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[TERMINAL/ORDERS POST]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
