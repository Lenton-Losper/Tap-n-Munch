import { NextResponse } from 'next/server'
import { createPaymentRequest } from '@/payments/paycloud'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const body = await req.json()
    const restaurantId = String(body.restaurantId || '').trim()
    const tableNumber = Number(body.tableNumber)
    const tabId = String(body.tabId ?? body.tab_id ?? '').trim()
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const sortedOrderIds = [...orderIds].sort()
    const clientAmount = Number(body.amount)

    if (!restaurantId || !Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid restaurant or table' }, { status: 400 })
    }
    if (orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No orders to pay' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', Number(tableNumber))
      .eq('is_closed', false)
      .order('placed_at', { ascending: true })

    const byId = new Map((orders || []).map((o: { id: string }) => [String(o.id), o]))

    const requiresSessionToken =
      Boolean(tabId) ||
      sortedOrderIds.some((orderId) => {
        const row = byId.get(orderId) as { tab_id?: string | null } | undefined
        return Boolean(row?.tab_id)
      })

    if (requiresSessionToken) {
      const guard = await requireSessionToken(req)
      if (guard.error) return guard.error
      const orderTabIds = sortedOrderIds
        .map((orderId) => {
          const row = byId.get(orderId) as { tab_id?: string | null } | undefined
          return String(row?.tab_id || '').trim()
        })
        .filter(Boolean)
      const boundTabId = String(tabId || orderTabIds[0] || '').trim()
      const mismatch = assertSessionMatchesResource(guard, {
        restaurantId: restaurantUuid,
        tabId: boundTabId || null,
      })
      if (mismatch) return mismatch
      if (
        orderTabIds.length > 0 &&
        orderTabIds.some((id) => id !== String(guard.tabId || '').trim())
      ) {
        return NextResponse.json(
          { ok: false, error: 'Session token does not match these orders' },
          { status: 403 },
        )
      }
    }

    let sum = 0
    for (const orderId of sortedOrderIds) {
      const data = byId.get(orderId) as Record<string, unknown> | undefined
      if (!data) {
        return NextResponse.json({ ok: false, error: `Order not found: ${orderId}` }, { status: 404 })
      }
      if (Number(data.table_number) !== tableNumber) {
        return NextResponse.json({ ok: false, error: 'Order does not match this table' }, { status: 400 })
      }
      if (data.is_closed === true) {
        return NextResponse.json({ ok: false, error: 'Cannot pay for a closed order' }, { status: 400 })
      }
      if (data.payment_status === 'paid') {
        console.log('[RECEIPT] Order already paid, blocking duplicate:', orderId)
        return NextResponse.json(
          {
            ok: false,
            error: 'This order has already been paid',
            code: 'ALREADY_PAID',
          },
          { status: 400 }
        )
      }
      sum += Number(data.total) || 0
    }

    const roundedSum = Math.round(sum * 100) / 100
    const roundedClient = Math.round(clientAmount * 100) / 100
    if (Math.abs(roundedSum - roundedClient) > 0.02) {
      return NextResponse.json(
        { ok: false, error: 'Amount does not match order total. Please refresh and try again.' },
        { status: 400 }
      )
    }

    let merchantNo: string
    let storeNo: string
    try {
      const credentials = await getRestaurantFinaticCredentials(restaurantId)
      merchantNo = credentials.checkoutMerchantNo
      storeNo = credentials.checkoutStoreNo
      console.log('[RECEIPT] Using checkout credentials:', { merchantNo, storeNo })
    } catch {
      return NextResponse.json(
        {
          error: 'This restaurant has not configured their payment credentials. Please update settings.',
        },
        { status: 400 }
      )
    }

    let merchantOrderNo = ''
    for (const orderId of sortedOrderIds) {
      const row = byId.get(orderId) as { paycloud_merchant_order_no?: string | null; payment_reference?: string | null }
      const cand = String(row?.paycloud_merchant_order_no || row?.payment_reference || '').trim()
      if (cand) {
        merchantOrderNo = cand
        break
      }
    }
    if (!merchantOrderNo) {
      merchantOrderNo = `FT${Date.now()}`.slice(0, 32)
    }

    const leadId = sortedOrderIds[0]
    const leadPatch = {
      payment_status: 'pending' as const,
      payment_provider: 'paycloud' as const,
      payment_reference: merchantOrderNo,
      paycloud_merchant_order_no: merchantOrderNo,
    }
    const siblingPatch = {
      payment_status: 'pending' as const,
      payment_provider: 'paycloud' as const,
      payment_reference: merchantOrderNo,
      paycloud_merchant_order_no: null as string | null,
    }

    const leadRes = await supabase.from('orders').update(leadPatch).eq('id', leadId)
    if (leadRes.error) {
      console.error('[RECEIPT] Failed to persist merchant order (lead):', leadRes.error)
      return NextResponse.json({ ok: false, error: leadRes.error.message }, { status: 500 })
    }

    const siblingIds = sortedOrderIds.filter((id) => id !== leadId)
    if (siblingIds.length > 0) {
      const sibRes = await Promise.all(
        siblingIds.map((id) => supabase.from('orders').update(siblingPatch).eq('id', id))
      )
      const sibErr = sibRes.find((r) => r.error)
      if (sibErr?.error) {
        console.error('[RECEIPT] Failed to persist merchant order (siblings):', sibErr.error)
        return NextResponse.json({ ok: false, error: sibErr.error.message }, { status: 500 })
      }
    }

    // PayCloud checkout body field `expires` (seconds only, never ms/timestamp) is set in payments/paycloud.js.
    const payment = await createPaymentRequest({
      amount: roundedSum,
      orderId: merchantOrderNo,
      merchantNo,
      storeNo,
      description: `FlashTap receipt - Table ${tableNumber} (${sortedOrderIds.length} order${sortedOrderIds.length > 1 ? 's' : ''})`,
      checkoutReturnParams: {
        rid: restaurantId,
        table: String(tableNumber),
      },
    })

    // Same as /api/payments/create: createPaymentRequest returns or throws, never resolves
    // undefined. Reject rather than continue -- the orders are already marked pending above, and
    // a 201 with defaulted fields would tell the payer a checkout exists for money that was never
    // requested from the gateway. Throwing leaves them pending, which is what every other
    // provider failure on this route already does.
    if (!payment) {
      throw new Error('PayCloud returned no payment result')
    }

    if (payment.checkoutUrl) {
      await Promise.all(
        sortedOrderIds.map((id) =>
          supabase.from('orders').update({ payment_checkout_url: payment.checkoutUrl }).eq('id', id)
        )
      )
    }

    return NextResponse.json(
      {
        ok: true,
        paymentStatus: payment.paymentStatus,
        requires3ds: payment.requires3ds,
        checkoutUrl: payment.checkoutUrl,
        merchantOrderNo,
      },
      {
        status: 201,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment failed'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
