import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createPaymentRequest } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/firebase/restaurant-credentials'

export const dynamic = 'force-dynamic'

function buildMerchantOrderNo(): string {
  return `FT${Date.now()}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
}

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const body = await req.json()
    const { tableNumber, ...rest } = body
    const {
      restaurantId,
      sessionId,
      memberSessionId,
      items,
      subtotal,
      total,
      paymentMethod,
      paymentChannel,
      orderInstructions,
      tabId,
      tabSettlementForTabId,
    } = rest

    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    // Determine payment status
    const resolvedPaymentMethod = paymentMethod || 'cash'
    const paymentStatus = resolvedPaymentMethod === 'cash' 
      ? 'cash_pending' 
      : 'pending'

    // Get next order number
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_restaurant_id', restaurantId)

    const orderNumber = (count || 0) + 1

    // Create order in Supabase
    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        firebase_restaurant_id: restaurantId,
        table_number: Number(tableNumber) || 0,
        session_id: sessionId || '',
        member_session_id: memberSessionId || null,
        payment_method: resolvedPaymentMethod,
        payment_channel: paymentChannel || null,
        payment_status: paymentStatus,
        status: 'new',
        subtotal: subtotal || 0,
        total: total || 0,
        items: items || [],
        order_instructions: orderInstructions || null,
        tab_id: tabId || null,
        tab_settlement_for_tab_id: tabSettlementForTabId || null,
        order_number: orderNumber,
        placed_at: new Date().toISOString()
      })
      .select()
      .single()

    if (orderError) {
      console.error('[ORDERS] Supabase insert error:', orderError)
      return NextResponse.json({ error: orderError.message }, { status: 500 })
    }

    const orderId = newOrder.id
    let checkoutUrl: string | null = null
    let merchantOrderNo: string | null = null

    // Handle hosted online checkout
    if (paymentChannel === 'hosted') {
      merchantOrderNo = buildMerchantOrderNo()

      const credentials = await getRestaurantFinaticCredentials(restaurantId)
      const merchantNo = credentials.merchantNo
      const storeNo = credentials.storeNo
      
      try {
        const paymentResult = await createPaymentRequest({
          merchantOrderNo,
          amount: total,
          currency: 'NAD',
          description: `FlashTap Table ${tableNumber} Order #${orderNumber}`,
          restaurantId,
          orderId,
          merchantNo,
          storeNo,
        })

        const paymentResultAny = paymentResult as { checkoutUrl?: string; pay_url?: string } | undefined
        checkoutUrl = paymentResultAny?.checkoutUrl || paymentResultAny?.pay_url || null

        // Update order with checkout details
        await supabase
          .from('orders')
          .update({
            paycloud_merchant_order_no: merchantOrderNo,
            payment_checkout_url: checkoutUrl,
          })
          .eq('id', orderId)

      } catch (payErr) {
        console.error('[ORDERS] Payment init failed:', payErr)
      }
    }

    return NextResponse.json({
      success: true,
      orderId,
      orderNumber,
      paymentStatus,
      checkoutUrl,
      merchantOrderNo,
    })

  } catch (error) {
    console.error('[ORDERS] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
