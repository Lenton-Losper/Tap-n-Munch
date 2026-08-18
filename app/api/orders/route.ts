import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope, resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { createPaymentRequest, paycloudWireMerchantOrderNo } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'
import { calculateOrderPricing, UnmatchedMenuItemError } from '@/lib/orders/calculate-order-pricing'
import { validateOrderQuantities } from '@/lib/orders/quantity-limits'
import { checkStockSufficiency } from '@/lib/orders/check-stock-sufficiency'

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

    // Bound the per-line quantity on customer-placed orders. calculateOrderPricing's
    // extractQuantity silently coerces anything unusable to 1 and accepts any positive finite
    // number, so without this a typo or a malformed client produces a priced order for 9999
    // or 2.5 of something -- or quietly turns a rejected value into a quantity-1 order the
    // customer never asked for. Rejecting is the point; coercion is what hid the problem.
    //
    // Staff POS (app/api/terminal/orders) is deliberately not capped: 30 coffees for a large
    // table is legitimate, and a staff miskey is caught by the person in front of them.
    if (channel === 'table' || channel === 'kiosk') {
      const quantityCheck = validateOrderQuantities(Array.isArray(items) ? items : [])
      if (!quantityCheck.ok) {
        return NextResponse.json({ error: quantityCheck.reason }, { status: 400 })
      }
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
      const mismatch = assertSessionMatchesResource(guard, {
        restaurantId: restaurantUuid,
        tabId: normalizedTabId,
      })
      if (mismatch) return mismatch
    }

    /**
     * ON A TAB ORDER, DO NOT INVENT A PAYMENT METHOD. Ruled 2026-08-19.
     *
     * This read `paymentMethod || 'cash'` for EVERY order. On a tab the customer is never asked
     * how they will pay -- payment happens at the table when the tab is settled -- so the row was
     * stamped 'cash' on nobody's authority, and the confirmation screen told a real customer
     * "Cash" as a fact. The route already knew: `paymentMethodIsChosenAtSubmission = !isTabOrder`
     * below skips the accepted-methods validation for exactly this reason.
     *
     * THE COMMENT THAT WAS HERE SAID "Tab orders: card only" and the line under it defaulted to
     * cash. Neither half was true, so both are gone.
     *
     * NULL IS THE HONEST VALUE and the schema already supports it: `order_requests.payment_method`
     * is nullable with no default. The `|| 'cash'` fallback is kept for the DIRECT-order path,
     * where the method IS chosen at submission and a missing one is a client bug rather than a
     * normal state.
     *
     * NOTE: `orders.payment_method` carries a column DEFAULT of 'cash' (baseline schema), so an
     * insert that omits the field still lands as cash. createOrder always passes a value, so
     * passing null here is what actually reaches the row -- but the default is a second, silent
     * source of the same wrong answer and wants a migration. Not changed here: that is a money
     * field and the change was referred for a ruling.
     */
    let resolvedPaymentMethod: string | null = isTabOrder ? (paymentMethod || null) : (paymentMethod || 'cash')
    let resolvedPaymentChannel = paymentChannel ?? null
    const channelLower = String(resolvedPaymentChannel || '').toLowerCase()
    let paymentStatus: string
    if (channelLower === 'cash' || channelLower === 'card_manual' || channelLower === 'other') {
      paymentStatus = 'pending'
    } else if (resolvedPaymentMethod === 'cash' && !resolvedPaymentChannel) {
      /**
       * Unchanged, and now unreachable for a tab order with no chosen method -- which is the
       * point. `cash_pending` was being derived from the invented 'cash', so the badge beside the
       * invented method was manufactured by it. A tab order with no method now takes the plain
       * `pending` branch below.
       */
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
        /**
         * THE TOKEN GUARD OWNS THIS REFUSAL. #303.
         *
         * This answered 400 with two bespoke sentences — one of them 'This tab is ready to pay —
         * you cannot add more items.', which #206's census had allowlisted as customer-visible.
         * MEASURED against deployed staging: no caller can reach either. `requireSessionToken`
         * runs above, and `validateSessionToken` refuses any tab whose status is not 'open' first
         * (lib/session-token.ts), so every shape — valid token, no token, bogus token — answers
         * 410 'Your dining session has ended…'.
         *
         * The strings documented a path that does not exist, and the code claimed a guarantee it
         * was not providing.
         *
         * THE CHECK STAYS, because the one opening is real: a sub-second race where the tab flips
         * to ready_to_pay between token validation and this load. Deleting it outright — the
         * literal reading of the issue's option B — would let a racing order land on a tab that is
         * being settled. What is deleted is the SECOND VOCABULARY: the same status and the same
         * sentence the token guard already gives, so there is one mechanism and one message
         * rather than two that disagree.
         */
        const tabStatus = String(tabRow.status || '')
        if (tabStatus !== 'open') {
          return NextResponse.json(
            {
              error: 'Your dining session has ended. Please scan the QR code to start a new order.',
              reason: 'tab_not_open',
            },
            { status: 410 },
          )
        }

      /**
       * THE DECISIVE LINE, and the one that actually reached production. Ruled 2026-08-19.
       *
       * This read:
       *
       *     if (!resolvedPaymentMethod || resolvedPaymentMethod === 'tab') {
       *       resolvedPaymentMethod = 'cash' // default to cash if nothing selected
       *     }
       *
       * "default to cash if nothing selected" is the defect stated as a comment. On a tab the
       * customer is NEVER asked, so "nothing selected" is the normal case, not an edge one — and
       * the confirmation screen then told them "Cash" as an established fact.
       *
       * `'tab'` is not a payment method either. It is the customer saying "put it on the tab",
       * which is a statement about WHEN they will pay, not HOW. It also becomes null.
       *
       * The preference the old comment wanted to preserve IS preserved: a customer who genuinely
       * chose cash or card still has it here, and only the invented value is removed.
       */
      if (!resolvedPaymentMethod || resolvedPaymentMethod === 'tab') {
        resolvedPaymentMethod = null
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

    // Refuse the order outright if a TRACKED item's ingredient stock is at zero or below.
    // Untracked items are skipped inside the check and behave exactly as before.
    //
    // This has to happen here rather than in deduct_recipe_stock: that runs from an AFTER
    // UPDATE trigger once the order is already being completed, so there is no longer a sale
    // to prevent. Blocking at placement is what "out of stock" means to a customer.
    try {
      const sufficiency = await checkStockSufficiency(supabase, restaurantUuid, Array.isArray(items) ? items : [])
      if (!sufficiency.ok) {
        return NextResponse.json(
          {
            error: sufficiency.reason,
            // Every unavailable item, so a client can highlight them all at once instead of
            // making the customer discover them one refusal at a time.
            outOfStock: sufficiency.unavailable.map((u) => ({
              item: u.itemName,
              ingredient: u.stockItemName,
            })),
          },
          { status: 409 },
        )
      }
    } catch (err) {
      // A failure to READ stock must not take ordering down. Log and continue -- refusing
      // every order because a balance query failed would be a worse outcome than the
      // occasional oversell this check exists to prevent.
      console.error('[ORDERS] stock sufficiency check failed, allowing order through:', err)
    }

    // Validate payment method against restaurant settings
    const { data: settings } = await supabase
      .from('restaurant_settings')
      .select('payment_methods, settings_version')
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    const allowedMethods = settings?.payment_methods ?? ['cash', 'card']

    // Validate the RESOLVED method, not the raw request field. `paymentMethod` is undefined
    // whenever the client omits it, so `paymentMethod && ...` short-circuited and skipped the
    // allowlist entirely -- while resolvedPaymentMethod had already defaulted to 'cash' above
    // and is what gets written to order_requests.payment_method / orders.payment_method below.
    // A card-only restaurant therefore accepted cash orders from any client that simply left
    // the field out. Checking the value that is actually persisted is the whole point. (#124)

    /**
     * A TAB order is exempt, and ONLY a tab order (#202).
     *
     * Not a relaxation of #124. On a tab, the customer does not choose a payment method when
     * they submit -- they choose it later, when the tab is settled at the table. So there is no
     * method to validate here, and `resolvedPaymentMethod` at this point is not the customer's
     * answer: it is the server's default from route.ts:109 (and again at :151), applied because
     * the field was absent. Validating it asks a question that has no answer yet and then judges
     * the invented one.
     *
     * That is the same shape of defect as #124, pointing the other way. #124 was "the server
     * invents 'cash' and does NOT check it, so a card-only restaurant books cash orders". This
     * is "the server invents 'cash' and DOES check it, so a card-only restaurant refuses every
     * tab submission". Both come from treating a defaulted value as a customer's choice.
     *
     * Live impact this fixes: Riviera and FNB ChowNow both sit at payment_methods=["card"] in
     * restaurant_settings, so every QR tab submission returned 403 PAYMENT_METHOD_REQUIRED --
     * at Riviera, which is the venue the QR path exists to serve.
     *
     * The real method is established at settlement, where it IS known and IS validated:
     * normalizeSettlementPaymentMethod() in lib/payments/payment-integrity.ts gates the terminal
     * settle routes against the card/cash allowlist. Nothing is left unchecked; the check moves
     * to the point where there is something to check.
     *
     * Scoped deliberately to `isTabOrder` (route.ts:94, true only when a tabId was supplied) so
     * that the DIRECT-ORDER path -- the one #124 was filed against -- validates exactly as it
     * did before, including the defaulted-value case.
     */
    const paymentMethodIsChosenAtSubmission = !isTabOrder

    if (paymentMethodIsChosenAtSubmission && !allowedMethods.includes(resolvedPaymentMethod)) {
      return NextResponse.json(
        {
          error: `This restaurant does not accept ${resolvedPaymentMethod} payments.`,
          // Separates "you asked for cash" from "you asked for nothing and the server defaulted
          // to cash", which is otherwise an inexplicable refusal to a customer who chose nothing.
          code: paymentMethod ? 'PAYMENT_METHOD_NOT_ACCEPTED' : 'PAYMENT_METHOD_REQUIRED',
          requestedPaymentMethod: paymentMethod ?? null,
          resolvedPaymentMethod,
          allowedPaymentMethods: allowedMethods,
          settingsVersion: settings?.settings_version ?? 1,
        },
        { status: 403 }
      )
    }

    let tableUuid: string | null = null
    let tableIsKiosk = false
    if (normalizedTableNumber > 0) {
      const { data: tableRow } = await supabase
        .from('restaurant_tables')
        .select('id, active, is_kiosk')
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
      tableIsKiosk = Boolean(tableRow.is_kiosk)
    }

    if (channel === 'kiosk') {
      if (normalizedTableNumber <= 0 || !tableIsKiosk) {
        return NextResponse.json(
          { error: 'This link is not configured as a kiosk.' },
          { status: 403 },
        )
      }
    }

    // Order Request / Accept model (staging rollout): table + kiosk submissions become an
    // order_request, not a real order, until staff Accept. Terminal/POS is a separate route
    // and is unaffected. route_to enrichment and the hosted-checkout session are deliberately
    // deferred to Accept -- see app/api/order-requests/[requestId]/accept/route.ts.
    if (channel === 'table' || channel === 'kiosk') {
      const pricing = await calculateOrderPricing(supabase, restaurantUuid, items)
      for (const warning of pricing.warnings) {
        console.warn('[ORDER_REQUESTS] pricing warning:', warning)
      }

      const { data: newRequest, error: requestError } = await supabase
        .from('order_requests')
        .insert({
          restaurant_id: restaurantUuid,
          firebase_restaurant_id: orderRestaurantScope.firebaseRestaurantId,
          channel,
          table_number: normalizedTableNumber,
          table_id: tableUuid,
          session_id: sessionId,
          member_session_id: memberSessionId,
          customer_name: customerName,
          order_instructions: orderInstructions || null,
          items: pricing.items,
          subtotal: pricing.subtotal,
          tax: pricing.tax,
          total: pricing.total,
          payment_method: resolvedPaymentMethod,
          payment_channel: resolvedPaymentChannel,
          tab_id: normalizedTabId || null,
          tab_settlement_for_tab_id: tabSettlementForTabId || null,
          idempotency_key: idempotencyKey,
          placed_at: new Date().toISOString(),
        })
        .select('id, restaurant_id')
        .single()

      if (requestError) {
        if (requestError.code === '23505' && idempotencyKey) {
          const { data: existing } = await supabase
            .from('order_requests')
            .select('id')
            .eq('idempotency_key', idempotencyKey)
            .single()
          if (existing?.id) {
            return NextResponse.json({
              success: true,
              orderId: existing.id,
              requestId: existing.id,
              status: 'waiting_review',
            })
          }
        }
        console.error('[ORDER_REQUESTS] Supabase insert error:', requestError)
        return NextResponse.json({ error: requestError.message }, { status: 500 })
      }

      console.log(`[ORDERS TIMING] total: ${(performance.now() - t0).toFixed(0)}ms`)
      return NextResponse.json({
        success: true,
        orderId: newRequest.id,
        requestId: newRequest.id,
        restaurantId: newRequest.restaurant_id,
        status: 'waiting_review',
        paymentStatus: 'waiting_review',
      })
    }

    // --- Legacy direct-order path (channels other than table/kiosk; terminal/POS uses its
    // own route and never reaches here). Unchanged. ---

    // Get next order number
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_restaurant_id', orderRestaurantScope.firebaseRestaurantId)

    const orderNumber = (count || 0) + 1
    const itemsWithRouting = await enrichOrderItemsWithRouteTo(supabase, items)

    const pricing = await calculateOrderPricing(supabase, restaurantUuid, itemsWithRouting)
    for (const warning of pricing.warnings) {
      console.warn('[ORDERS] pricing warning:', warning)
    }
    const clientSubtotal = Number(subtotal)
    const clientTotal = Number(total)
    if (Number.isFinite(clientTotal) && Math.abs(clientTotal - pricing.total) > 0.01) {
      console.warn('[ORDERS] client/server total mismatch — using server-recomputed total', {
        restaurantId: restaurantUuid,
        clientSubtotal,
        clientTotal,
        serverSubtotal: pricing.subtotal,
        serverTax: pricing.tax,
        serverTotal: pricing.total,
      })
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
        subtotal: pricing.subtotal,
        tax: pricing.tax,
        total: pricing.total,
        items: pricing.items,
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
          .select(
            'id, restaurant_id, order_number, payment_status, payment_checkout_url, paycloud_merchant_order_no, kiosk_order_number, channel',
          )
          .eq('idempotency_key', idempotencyKey)
          .single()
        if (existing?.id) {
          const existingKioskNumber =
            existing.kiosk_order_number != null ? Number(existing.kiosk_order_number) : undefined
          return NextResponse.json({
            success: true,
            orderId: existing.id,
            restaurantId: existing.restaurant_id,
            orderNumber: existing.order_number,
            paymentStatus: existing.payment_status,
            checkoutUrl: existing.payment_checkout_url || null,
            merchantOrderNo: existing.paycloud_merchant_order_no || null,
            ...(existingKioskNumber != null && Number.isFinite(existingKioskNumber)
              ? {
                  kioskOrderNumber: existingKioskNumber,
                  kioskOrderLabel: `K-${String(existingKioskNumber).padStart(3, '0')}`,
                }
              : {}),
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
          amount: pricing.total,
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

        if (!checkoutUrl) {
          await supabase
            .from('orders')
            .update({ payment_status: 'failed' })
            .eq('id', orderId)
          return NextResponse.json(
            {
              error: 'Payment link was not returned by PayCloud',
              orderId,
              paymentStatus: 'failed',
            },
            { status: 502 },
          )
        }

        const wireNo = paycloudWireMerchantOrderNo(orderId)
        merchantOrderNo = wireNo

        const { error: checkoutUpdateError } = await supabase
          .from('orders')
          .update({
            paycloud_merchant_order_no: wireNo,
            payment_checkout_url: checkoutUrl,
          })
          .eq('id', orderId)

        if (checkoutUpdateError) {
          console.error('[ORDERS] checkout URL persist failed:', checkoutUpdateError)
          return NextResponse.json(
            {
              error: 'Failed to persist payment session',
              orderId,
            },
            { status: 502 },
          )
        }
      } catch (payErr) {
        console.error('[ORDERS] Payment init failed:', payErr)
        await supabase
          .from('orders')
          .update({ payment_status: 'failed' })
          .eq('id', orderId)
        return NextResponse.json(
          {
            error: payErr instanceof Error ? payErr.message : 'Payment initialization failed',
            orderId,
            paymentStatus: 'failed',
          },
          { status: 502 },
        )
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
    if (error instanceof UnmatchedMenuItemError) {
      // Same shape the out-of-stock refusal already returns (`outOfStock: [...]`, :194): a
      // sentence for the customer plus the offending lines, so a client can highlight all of
      // them at once instead of making the customer discover a bad cart one refusal at a time.
      // `code` is what probes and clients should branch on — the sentence is placeholder copy.
      return NextResponse.json(
        { error: error.message, code: error.code, unavailableItems: error.items },
        { status: 400 },
      )
    }
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
    const mismatch = assertSessionMatchesResource(guard, {
      restaurantId: restaurantUuid,
      tabId,
    })
    if (mismatch) return mismatch

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
