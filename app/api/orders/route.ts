import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope, resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { createPaymentRequest, paycloudWireMerchantOrderNo } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { requireSessionToken } from '@/lib/session-guard'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const t0 = performance.now()
    const idempotencyKey = req.headers.get('x-idempotency-key') || null

    const body = await req.json()
    const { tableNumber, ...rest } = body
    const channel = String(body.channel ?? 'table').trim()
    const customerName = String(body.customer_name ?? body.customerName ?? '').trim() || null

    const restaurantIdRaw =
      rest.restaurantId ?? rest.restaurant_id ?? body.restaurantId ?? body.restaurant_id
    const restaurantId = String(restaurantIdRaw || '').trim()

    const sessionId = String(rest.sessionId ?? rest.session_id ?? '').trim()
    const memberSessionId = String(rest.memberSessionId ?? rest.member_session_id ?? '').trim() || null
    const items = rest.items
    const subtotal = rest.subtotal
    const total = rest.total
    const paymentMethod =
      rest.paymentMethod != null && String(rest.paymentMethod).trim() !== ''
        ? String(rest.paymentMethod).trim()
        : undefined
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

    // Real enforcement, not just a disabled Add-to-Cart button -- a view-only ordering
    // point can never accept an order, regardless of channel or whether a (possibly
    // forged/stale) tabId is present, so this runs unconditionally before any of the
    // tab-order/kiosk-exemption branches below.
    if (normalizedTableNumber > 0) {
      const { data: viewOnlyCheckRow, error: viewOnlyCheckError } = await supabase
        .from('restaurant_tables')
        .select('is_view_only')
        .eq('restaurant_id', restaurantUuid)
        .eq('table_number', normalizedTableNumber)
        .maybeSingle()

      if (viewOnlyCheckError) {
        console.error('[ORDERS] view-only check failed', viewOnlyCheckError)
        return NextResponse.json({ error: viewOnlyCheckError.message }, { status: 500 })
      }
      if (viewOnlyCheckRow?.is_view_only) {
        return NextResponse.json(
          { error: 'This is a view-only menu — ordering is not available here.' },
          { status: 403 },
        )
      }
    }

    const normalizedTabId = tabId ? String(tabId).trim() : ''
    const isTabOrder = Boolean(normalizedTabId)

    if (normalizedTabId) {
      const tToken = performance.now()
      const guard = await requireSessionToken(req)
      console.log(`[ORDERS TIMING] token validation: ${(performance.now() - tToken).toFixed(0)}ms`)
      if (guard.error) return guard.error
    }

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

      // Preserve the customer's payment preference — do not overwrite with 'tab'
      // resolvedPaymentMethod already contains cash/card/other from the request
      // Only override if no valid payment method was sent
      if (!resolvedPaymentMethod || resolvedPaymentMethod === 'tab') {
        resolvedPaymentMethod = 'cash' // default to cash if nothing selected
      }
      paymentStatus = 'pending'
      resolvedPaymentChannel = resolvedPaymentChannel || null
    }

    if (!isTabOrder && channel !== 'kiosk') {
      const { data: openTabForTable, error: openTabError } = await supabase
        .from('tabs')
        .select('id')
        .eq('restaurant_id', restaurantUuid)
        .eq('table_number', normalizedTableNumber)
        .eq('status', 'open')
        .maybeSingle()

      if (openTabError) {
        console.error('[ORDERS] open tab check failed', openTabError)
        return NextResponse.json({ error: openTabError.message }, { status: 500 })
      }

      if (!openTabForTable) {
        return NextResponse.json(
          { error: 'This table has been closed. Please scan the QR code to start a new session.' },
          { status: 403 }
        )
      }
    }

    // Get next order number
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_restaurant_id', orderRestaurantScope.firebaseRestaurantId)

    const orderNumber = (count || 0) + 1
    const itemsWithRouting = await enrichOrderItemsWithRouteTo(supabase, items)

    // Validate payment method against restaurant settings
    const { data: settings } = await supabase
      .from('restaurant_settings')
      .select('payment_methods, settings_version')
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    const allowedMethods = settings?.payment_methods ?? ['cash', 'card']
    if (paymentMethod && !allowedMethods.includes(paymentMethod)) {
      return NextResponse.json(
        {
          error: `This restaurant does not accept ${paymentMethod} payments.`,
          settingsVersion: settings?.settings_version ?? 1,
        },
        { status: 403 }
      )
    }

    let tableUuid: string | null = null
    if (normalizedTableNumber > 0) {
      const { data: tableRow } = await supabase
        .from('restaurant_tables')
        .select('id, active')
        .eq('restaurant_id', restaurantUuid)
        .eq('table_number', normalizedTableNumber)
        .eq('active', true)
        .maybeSingle()

      if (!tableRow?.id) {
        return NextResponse.json(
          { error: 'This table is not available for ordering.' },
          { status: 403 },
        )
      }
      tableUuid = tableRow.id
    }

    // Create order in Supabase
    const t2 = performance.now()
    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        restaurant_id: restaurantUuid,
        firebase_restaurant_id: orderRestaurantScope.firebaseRestaurantId,
        table_number: normalizedTableNumber,
        table_id: tableUuid,
        session_id: sessionId,
        member_session_id: memberSessionId,
        payment_method: resolvedPaymentMethod,
        payment_channel: resolvedPaymentChannel,
        payment_status: paymentStatus,
        status: 'pending',
        subtotal: subtotal || 0,
        total: total || 0,
        items: itemsWithRouting,
        order_instructions: orderInstructions || null,
        tab_id: normalizedTabId || null,
        tab_settlement_for_tab_id: tabSettlementForTabId || null,
        order_number: orderNumber,
        channel,
        customer_name: customerName,
        placed_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
      })
      .select('id, restaurant_id, order_number, payment_status, total')
      .single()
    console.log(`[ORDERS TIMING] order insert: ${(performance.now() - t2).toFixed(0)}ms`)

    if (orderError) {
      if (orderError.code === '23505' && idempotencyKey) {
        const { data: existing } = await supabase
          .from('orders')
          .select('id')
          .eq('idempotency_key', idempotencyKey)
          .single()
        if (existing?.id) {
          return NextResponse.json({ success: true, orderId: existing.id })
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

    let kioskOrderNumber: number | undefined
    let kioskOrderLabel: string | undefined

    if (channel === 'kiosk') {
      const today = new Date().toISOString().split('T')[0]
      const { count: kioskCount } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantUuid)
        .eq('channel', 'kiosk')
        .gte('placed_at', `${today}T00:00:00Z`)

      const kioskNumber = (kioskCount ?? 0) + 1
      await supabase
        .from('orders')
        .update({ kiosk_order_number: kioskNumber })
        .eq('id', orderId)

      kioskOrderNumber = kioskNumber
      kioskOrderLabel = `K-${String(kioskNumber).padStart(3, '0')}`
    }

    const t3 = performance.now()
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
    console.log(`[ORDERS TIMING] order items insert: ${(performance.now() - t3).toFixed(0)}ms`)

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
      ...(kioskOrderNumber != null ? { kioskOrderNumber, kioskOrderLabel } : {}),
    }

    console.log(`[ORDERS TIMING] total: ${(performance.now() - t0).toFixed(0)}ms`)
    return NextResponse.json(successPayload)
  } catch (error) {
    console.error('[ORDERS] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const { searchParams } = new URL(req.url)
    const tabId = String(searchParams.get('tabId') || searchParams.get('tab_id') || '').trim()
    const restaurantIdRaw = String(
      searchParams.get('restaurantId') || searchParams.get('restaurant_id') || ''
    ).trim()

    if (!tabId) {
      return NextResponse.json({ error: 'tabId is required' }, { status: 400 })
    }

    const guard = await requireSessionToken(req)
    if (guard.error) return guard.error

    if (!restaurantIdRaw) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantIdRaw)

    const { data, error } = await supabase
      .from('orders')
      .select('id, status, payment_status, total, placed_at, tab_id, session_id')
      .eq('restaurant_id', restaurantUuid)
      .eq('tab_id', tabId)
      .eq('is_closed', false)
      .order('placed_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, orders: data || [] })
  } catch (error) {
    console.error('[ORDERS] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
