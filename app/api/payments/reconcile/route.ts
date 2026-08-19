import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { queryPaymentOrder } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'

function toMoney(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

async function loadOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantUuid: string,
  orderIds: string[],
) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .in('id', orderIds)

  if (error) throw error
  const rows = (data || []).map((row: Record<string, unknown>) => ({
    orderId: String(row.id),
    data: row,
  }))
  if (rows.length !== orderIds.length) {
    throw new Error('One or more orders were not found')
  }
  return rows
}

export async function POST(req: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.PAYMENTS_PROCESS, req)
    if (isAuthError(auth)) return auth

    const { supabase, restaurantId: callerRestaurantId } = auth
    const body = await req.json()
    const restaurantId = String(body.restaurantId || callerRestaurantId || '').trim()
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const merchantOrderNoRaw = String(body.merchantOrderNo || '').trim()

    if (!restaurantId || orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'restaurantId and orderIds are required' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    if (restaurantUuid !== callerRestaurantId) {
      return NextResponse.json(
        { ok: false, error: 'restaurantId does not match authenticated restaurant' },
        { status: 403 },
      )
    }

    console.log('[RECONCILE] start', {
      restaurantId: restaurantUuid,
      orderIds,
    })

    const rows = await loadOrders(supabase, restaurantUuid, orderIds)
    for (const r of rows) {
      console.log('[RECONCILE] loaded order', {
        orderId: r.orderId,
        status: r.data.status,
        payment_status: r.data.payment_status,
        payment_method: r.data.payment_method,
        tab_id: r.data.tab_id ?? null,
        tab_settlement_for_tab_id: r.data.tab_settlement_for_tab_id ?? null,
        tab_settlement_member_session_id: r.data.tab_settlement_member_session_id ?? null,
        member_session_id: r.data.member_session_id ?? null,
      })
    }
    if (rows.every((r) => r.data.payment_status === 'paid')) {
      return NextResponse.json({ ok: true, paid: true, source: 'supabase' }, { status: 200 })
    }

    const expectedAmount = Math.round(rows.reduce((s, r) => s + (Number(r.data.total) || 0), 0) * 100) / 100
    const merchantOrderNoFromOrders = rows
      .map((r) => String(r.data.paycloud_merchant_order_no || '').trim())
      .find(Boolean)
    const merchantOrderNo =
      merchantOrderNoRaw ||
      merchantOrderNoFromOrders ||
      (orderIds.length === 1 ? `${restaurantId}:${orderIds[0]}` : `${restaurantId}:receipt:${orderIds.join(',')}`)

    const { merchantNo, storeNo } = await getRestaurantFinaticCredentials(restaurantId)
    const query = await queryPaymentOrder({ orderId: merchantOrderNo, merchantNo, storeNo })
    const raw = query.rawResponse || {}

    // Finatic returns `data` as a JSON string; parse before checking trans_status.
    let orderData: unknown = (raw as Record<string, unknown>)?.data
    if (typeof orderData === 'string') {
      try {
        orderData = JSON.parse(orderData)
      } catch {
        console.warn('[RECONCILE] Failed to parse order data string')
      }
    }

    const transStatus =
      (orderData as Record<string, unknown> | null)?.trans_status ??
      (raw as Record<string, unknown>)?.trans_status
    console.log(
      '[RECONCILE] trans_status=',
      transStatus,
      'orderData=',
      JSON.stringify(orderData ?? null)
    )

    const paid =
      transStatus === 2 ||
      transStatus === '2' ||
      ['paid', 'success', 'succeeded'].includes(
        String(
          (orderData as Record<string, unknown> | null)?.trade_status ??
            (orderData as Record<string, unknown> | null)?.status ??
            (raw as Record<string, unknown>)?.trade_status ??
            (raw as Record<string, unknown>)?.status ??
            ''
        ).toLowerCase()
      )

    if (!paid) {
      const statusText = String(
        (orderData as Record<string, unknown> | null)?.trade_status ??
          (orderData as Record<string, unknown> | null)?.status ??
          (raw as Record<string, unknown>)?.trade_status ??
          (raw as Record<string, unknown>)?.status ??
          transStatus ??
          'unknown'
      ).toLowerCase()
      return NextResponse.json(
        { ok: true, paid: false, source: 'query', status: statusText || 'unknown', merchantOrderNo },
        { status: 200 }
      )
    }

    const paidAmount = toMoney(
      (orderData as Record<string, unknown> | null)?.amount ??
        (orderData as Record<string, unknown> | null)?.order_amount ??
        (orderData as Record<string, unknown> | null)?.paid_amount ??
        (raw as Record<string, unknown>)?.amount ??
        (raw as Record<string, unknown>)?.order_amount ??
        (raw as Record<string, unknown>)?.paid_amount
    )
    /**
     * #197, ruled inside #190 — this was the FIFTH gateway gate and the only one that never
     * called amountsMatch:
     *
     *     if (paidAmount !== null && Math.abs(paidAmount - expectedAmount) > 0.02)
     *
     * #180 swept the amountsMatch call sites, so a raw float comparison at two cents was
     * invisible to it. It carried both defects at once — the float artefact (|78.36 - 78.35| is
     * 0.010000000000005116, not 0.01) and the null hole (`paidAmount !== null` short-circuits and
     * the whole batch is marked paid with no amount check of any kind).
     *
     * This is a GATEWAY leg: paidAmount comes off Finatic's order.query response, echoing back
     * our own figure, so it takes exact agreement and no tolerance — see
     * GATEWAY_AMOUNT_TOLERANCE_CENTS. An absent amount is unverified, not agreed.
     *
     * It is staff-triggered and it marks orders paid DIRECTLY, in a batch whose totals are summed
     * into one expected figure — so a wrong answer here is written across every order at once.
     * The refusal therefore writes one payment.verification_uncertain row PER ORDER: the staff
     * member sees the 409, but nobody else does, and these are charged customers whose orders
     * stay unpaid. The resolution procedure finds them by entity_id on that action.
     */
    const amountVerified =
      paidAmount !== null &&
      amountsMatch(paidAmount, expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS)

    if (!amountVerified) {
      const error =
        paidAmount === null
          ? `Amount unverified. Finatic reports paid for ${merchantOrderNo} but returned no amount, ` +
            `so the expected ${expectedAmount.toFixed(2)} could not be confirmed.`
          : `Amount mismatch. Expected ${expectedAmount.toFixed(2)}, got ${paidAmount.toFixed(2)}`
      console.error('[RECONCILE] refusing to mark paid:', error)

      for (const { orderId } of rows) {
        const { error: uncertainAuditError } = await supabase.from('audit_logs').insert({
          restaurant_id: restaurantUuid,
          action: 'payment.verification_uncertain',
          entity_type: 'order',
          entity_id: orderId,
          metadata: {
            reason: error,
            // A null finaticAmount is the "never checked" case and must stay distinguishable
            // from a figure that was checked and agreed.
            finaticAmount: paidAmount,
            expectedAmount,
            amountVerified: false,
            businessOrderNo: merchantOrderNo,
            // The batch this order was reconciled in — expectedAmount is their SUM, so a single
            // order's total will not match it and the row would be unreadable without this.
            batchOrderIds: orderIds,
            source: 'staff_reconcile',
            outcome: 'left_pending_finatic_uncertain',
          },
        })
        if (uncertainAuditError) {
          console.error(
            '[RECONCILE] payment.verification_uncertain audit failed:',
            uncertainAuditError,
          )
        }
      }

      return NextResponse.json(
        {
          ok: false,
          paid: false,
          error,
          outcome: 'left_pending_finatic_uncertain',
          expectedAmount,
          paidAmount,
        },
        { status: 409 }
      )
    }

    const transId = String(raw.psn || raw.transaction_id || '') || null

    /**
     * #234. THIS ROUTE MARKED ORDERS PAID WITH NO `paid_at`, AND THE SAFETY NET COULD NOT SEE THEM.
     *
     * `orders.paid_at` is nullable with no default and no trigger, so an order reconciled here had
     * `payment_status='paid'` and `paid_at IS NULL`. The paid-but-never-issued sweep in
     * reconcile-orphan-payments filters `.eq('payment_status','paid').gte('paid_at', since)`, and
     * a NULL fails that comparison — so a staff-reconciled order was PERMANENTLY invisible to the
     * compensating control, not merely late to it.
     *
     * The customer therefore never got a receipt, and the mechanism that exists to catch exactly
     * that could not.
     *
     * FIX-FORWARD ONLY, and this is the honest limit: the TRUE payment date does not exist
     * anywhere for these orders. The gateway settled at some earlier moment this route never
     * learns. Stamping `now()` records when the RECONCILIATION happened, which is a real fact and
     * the one the sweep needs — it is NOT a claim about when the customer paid. Historical rows
     * already carrying NULL are left alone; inventing a date for them would be worse than the gap.
     *
     * Only set when it is absent, so a re-run cannot move a date that a real settlement wrote.
     */
    const reconciledAt = new Date().toISOString()
    for (const { orderId, data } of rows) {
      const currentStatusRaw = String(data.status || '')
      const nextStatus =
        currentStatusRaw === 'pending' ? 'accepted' : currentStatusRaw || 'accepted'
      const patch: Record<string, unknown> = {
        status: nextStatus,
        payment_status: 'paid',
        paycloud_transaction_id: transId,
      }
      if (!data.paid_at) patch.paid_at = reconciledAt

      const { error } = await supabase.from('orders').update(patch).eq('id', orderId)
      if (error) throw error
    }

    return NextResponse.json({ ok: true, paid: true, source: 'query', merchantOrderNo }, { status: 200 })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to reconcile payment'
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
