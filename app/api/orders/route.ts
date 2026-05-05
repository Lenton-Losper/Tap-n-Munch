import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createPaymentRequest, paycloudWireMerchantOrderNo } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/firebase/restaurant-credentials'
import { CacheKeys, redis, TTL } from '@/lib/redis'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const idempotencyKey = req.headers.get('x-idempotency-key')?.trim() || ''

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

    const normalizedTableNumber = Number(tableNumber) || 0
    const rateLimitKey = CacheKeys.rateLimit(restaurantId, normalizedTableNumber)
    try {
      const count = await redis.incr(rateLimitKey)
      if (count === 1) {
        await redis.expire(rateLimitKey, TTL.RATE_LIMIT)
      }
      if (count > 10) {
        console.warn('[RATE LIMIT] Too many orders from table:', normalizedTableNumber)
        return NextResponse.json({ error: 'Too many orders. Please wait a moment.' }, { status: 429 })
      }
    } catch (err) {
      console.error('[RATE LIMIT] Redis error, skipping rate limit:', err)
    }

    if (idempotencyKey) {
      try {
        const existing = await redis.get(CacheKeys.idempotency(idempotencyKey))
        if (existing) {
          console.log('[ORDERS] Duplicate request blocked via Redis:', idempotencyKey)
          return NextResponse.json(typeof existing === 'string' ? JSON.parse(existing) : existing)
        }
      } catch (err) {
        console.error('[ORDERS] Redis idempotency check failed:', err)
      }
    }

    // Determine payment status
    const resolvedPaymentMethod = paymentMethod || 'cash'
    const paymentStatus = resolvedPaymentMethod === 'cash' ? 'cash_pending' : 'pending'

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
          table_number: normalizedTableNumber,
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
        placed_at: new Date().toISOString(),
        idempotency_key: idempotencyKey || null,
      })
      .select()
      .single()

    if (orderError) {
      if (orderError.code === '23505' && idempotencyKey) {
        const { data: existingOrder } = await supabase
          .from('orders')
          .select(
            'id, order_number, total, payment_status, payment_channel, payment_checkout_url, paycloud_merchant_order_no'
          )
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle()
        if (existingOrder) {
          try {
            await redis.setex(
              CacheKeys.idempotency(idempotencyKey),
              TTL.IDEMPOTENCY,
              JSON.stringify({
                success: true,
                orderId: existingOrder.id,
                orderNumber: existingOrder.order_number,
                paymentStatus: existingOrder.payment_status,
                checkoutUrl: existingOrder.payment_checkout_url,
                merchantOrderNo: existingOrder.paycloud_merchant_order_no,
                duplicate: true,
              })
            )
          } catch (err) {
            console.error('[ORDERS] Failed to store idempotency key in Redis:', err)
          }
          console.log('[ORDERS] Insert race resolved, returning existing order:', existingOrder.id)
          return NextResponse.json({
            success: true,
            orderId: existingOrder.id,
            orderNumber: existingOrder.order_number,
            paymentStatus: existingOrder.payment_status,
            checkoutUrl: existingOrder.payment_checkout_url,
            merchantOrderNo: existingOrder.paycloud_merchant_order_no,
            duplicate: true,
          })
        }
      }
      console.error('[ORDERS] Supabase insert error:', orderError)
      return NextResponse.json({ error: orderError.message }, { status: 500 })
    }

    const orderId = newOrder.id
    let checkoutUrl: string | null = null
    let merchantOrderNo: string | null = null

    const checkoutReturnParams = {
      rid: String(restaurantId),
      table: String(normalizedTableNumber),
    }

    // Handle hosted online checkout
    if (paymentChannel === 'hosted') {
      let merchantNo: string
      let storeNo: string
      try {
        const credentials = await getRestaurantFinaticCredentials(restaurantId)
        merchantNo = credentials.checkoutMerchantNo || credentials.merchantNo
        storeNo = credentials.checkoutStoreNo || credentials.storeNo
      } catch (credErr) {
        console.error('[ORDERS] Finatic credentials:', credErr)
        return NextResponse.json(
          {
            error: 'This restaurant has not configured their payment credentials. Please update settings.',
          },
          { status: 400 }
        )
      }

      try {
        const paymentResult = await createPaymentRequest({
          amount: total,
          currency: 'NAD',
          description: `FlashTap Table ${tableNumber} Order #${orderNumber}`,
          restaurantId,
          orderId,
          merchantNo,
          storeNo,
          checkoutReturnParams,
        })

        const paymentResultAny = paymentResult as { checkoutUrl?: string; pay_url?: string } | undefined
        checkoutUrl = paymentResultAny?.checkoutUrl || paymentResultAny?.pay_url || null

        const wireNo = paycloudWireMerchantOrderNo(orderId)
        merchantOrderNo = wireNo

        // Update order with checkout details (wire merchant no matches Finatic `tn` on return URL)
        await supabase
          .from('orders')
          .update({
            paycloud_merchant_order_no: wireNo,
            payment_checkout_url: checkoutUrl,
          })
          .eq('id', orderId)
      } catch (payErr) {
        console.error('[ORDERS] Payment init failed:', payErr)
      }
    }

    const successPayload = {
      success: true,
      orderId,
      orderNumber,
      paymentStatus,
      checkoutUrl,
      merchantOrderNo,
    }

    if (idempotencyKey) {
      try {
        await redis.setex(CacheKeys.idempotency(idempotencyKey), TTL.IDEMPOTENCY, JSON.stringify(successPayload))
      } catch (err) {
        console.error('[ORDERS] Failed to store idempotency key in Redis:', err)
      }
    }

    return NextResponse.json(successPayload)
  } catch (error) {
    console.error('[ORDERS] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
