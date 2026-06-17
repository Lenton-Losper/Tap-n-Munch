import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope, resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { createPaymentRequest, paycloudWireMerchantOrderNo } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { CacheKeys, redis, TTL } from '@/lib/redis'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const idempotencyKey = req.headers.get('x-idempotency-key')?.trim() || ''

    const body = await req.json()
    const { tableNumber, ...rest } = body

    const restaurantIdRaw =
      rest.restaurantId ?? rest.restaurant_id ?? body.restaurantId ?? body.restaurant_id
    const restaurantId = String(restaurantIdRaw || '').trim()

    const sessionId = String(rest.sessionId ?? rest.session_id ?? '').trim()
    const memberSessionId = String(rest.memberSessionId ?? rest.member_session_id ?? '').trim() || null
    const items = rest.items
    const subtotal = rest.subtotal
    const total = rest.total
    const paymentMethod = rest.paymentMethod
    const paymentChannel = rest.paymentChannel
    const orderInstructions = rest.orderInstructions
    const tabId = rest.tabId ?? rest.tab_id ?? null
    const tabSettlementForTabId =
      rest.tabSettlementForTabId ?? rest.tab_settlement_for_tab_id ?? null

    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const orderRestaurantScope = await resolveOrderRestaurantScope(restaurantId)

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

    const normalizedTabId = tabId ? String(tabId).trim() : ''
    const isTabOrder = Boolean(normalizedTabId)

    // Tab orders: card only, pending until tab is settled at the table
    let resolvedPaymentMethod = paymentMethod || 'cash'
    let resolvedPaymentChannel = paymentChannel ?? null
    const channelLower = String(resolvedPaymentChannel || '').toLowerCase()
    let paymentStatus: string
    if (channelLower === 'cash' || channelLower === 'card_manual' || channelLower === 'other') {
      paymentStatus = 'pending'
    } else if (resolvedPaymentMethod === 'cash' && !resolvedPaymentChannel) {
      paymentStatus = 'cash_pending'
    } else {
      paymentStatus = 'pending'
    }

    if (isTabOrder) {
      console.log('[ORDERS] tab order', { tabId: normalizedTabId, restaurantUuid })
      const { data: tabRow, error: tabLoadError } = await supabase
        .from('tabs')
        .select('id, status, total, members')
        .eq('id', normalizedTabId)
        .eq('restaurant_id', restaurantUuid)
        .maybeSingle()

      if (tabLoadError) {
        console.error('[ORDERS] tab load error', tabLoadError)
        return NextResponse.json({ error: tabLoadError.message }, { status: 500 })
      }
      if (!tabRow) {
        return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
      }
      const tabStatus = String(tabRow.status || '')
      if (tabStatus === 'ready_to_pay') {
        return NextResponse.json(
          { error: 'This tab is ready to pay — you cannot add more items.' },
          { status: 400 }
        )
      }
      if (tabStatus !== 'open') {
        return NextResponse.json({ error: `Tab is not open (status=${tabStatus})` }, { status: 400 })
      }

      resolvedPaymentMethod = 'tab'
      paymentStatus = 'pending'
      resolvedPaymentChannel = null
    }

    // Get next order number
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_restaurant_id', orderRestaurantScope.firebaseRestaurantId)

    const orderNumber = (count || 0) + 1

    // Create order in Supabase
    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        restaurant_id: restaurantUuid,
        firebase_restaurant_id: orderRestaurantScope.firebaseRestaurantId,
        table_number: normalizedTableNumber,
        session_id: sessionId,
        member_session_id: memberSessionId,
        payment_method: resolvedPaymentMethod,
        payment_channel: resolvedPaymentChannel,
        payment_status: paymentStatus,
        status: 'pending',
        subtotal: subtotal || 0,
        total: total || 0,
        items: items || [],
        order_instructions: orderInstructions || null,
        tab_id: normalizedTabId || null,
        tab_settlement_for_tab_id: tabSettlementForTabId || null,
        order_number: orderNumber,
        placed_at: new Date().toISOString(),
        idempotency_key: idempotencyKey || null,
      })
      .select('id, restaurant_id, order_number, payment_status, total')
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

    if (!newOrder?.restaurant_id) {
      console.error('[ORDERS] Insert succeeded but restaurant_id is missing on row:', newOrder?.id)
      return NextResponse.json({ error: 'Order created without restaurant_id' }, { status: 500 })
    }

    const orderId = newOrder.id

    if (isTabOrder) {
      console.log('[ORDERS] updating tab total and members', normalizedTabId)
      const { data: tabRow, error: tabReloadError } = await supabase
        .from('tabs')
        .select('total, members')
        .eq('id', normalizedTabId)
        .single()

      if (!tabReloadError && tabRow) {
        const members = Array.isArray(tabRow.members) ? [...tabRow.members] : []
        const sid = memberSessionId || sessionId
        if (sid && !members.some((m: { session_id?: string }) => String(m?.session_id) === sid)) {
          members.push({
            session_id: sid,
            joined_at: new Date().toISOString(),
            display_name: `Person ${members.length + 1}`,
          })
        }
        const { data: tabOrdersForTotal, error: tabOrdersSumError } = await supabase
          .from('orders')
          .select('total, tab_settlement_for_tab_id')
          .eq('tab_id', normalizedTabId)

        if (tabOrdersSumError) {
          console.error('[ORDERS] tab orders sum failed', tabOrdersSumError)
        }

        const nextTotal = (tabOrdersForTotal || [])
          .filter((o) => !String(o.tab_settlement_for_tab_id || '').trim())
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0)

        const { error: tabUpdateError } = await supabase
          .from('tabs')
          .update({ total: nextTotal, members })
          .eq('id', normalizedTabId)
        if (tabUpdateError) {
          console.error('[ORDERS] tab total update failed', tabUpdateError)
        } else {
          console.log('[ORDERS] tab updated', { tabId: normalizedTabId, nextTotal })
        }
      }
    }

    let checkoutUrl: string | null = null
    let merchantOrderNo: string | null = null

    const checkoutReturnParams = {
      rid: String(restaurantUuid),
      table: String(normalizedTableNumber),
    }

    // Handle hosted online checkout (not used for tab orders)
    if (!isTabOrder && resolvedPaymentChannel === 'hosted') {
      let merchantNo: string
      let storeNo: string
      try {
        const credentials = await getRestaurantFinaticCredentials(restaurantId)
        merchantNo = credentials.checkoutMerchantNo
        storeNo = credentials.checkoutStoreNo
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
      restaurantId: newOrder.restaurant_id,
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
