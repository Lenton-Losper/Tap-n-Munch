import { NextResponse } from 'next/server'
import {
  getRestaurantFinaticCredentials,
  isMissingFinaticCredentialsError,
} from '@/lib/payments/finatic-restaurant-credentials'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { isPaidPaymentStatus, owesMoney } from '@/lib/payments/payment-integrity'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '@/lib/payments/query-finatic-order-paid'
import { loadOrderFinancials, FinancialsUnreadable } from '@/lib/orders/order-financials'
import { settleWholeOrderPayment } from '@/lib/payments/settle-whole-order-payment'
import { bindReferenceToOrders, referenceConsumption } from '@/lib/payments/reconcile-reference'

/**
 * STAFF RECONCILIATION: "the customer was charged, the order does not show it".
 *
 * ==================================================================================================
 * WHAT CHANGED (Sprint 2026-09-29 brief, task 4)
 * ==================================================================================================
 *
 * This route took client-chosen `orderIds` and a client-chosen `merchantOrderNo`, asked Finatic
 * about the reference, and if the amount equalled the orders' summed totals it ran an
 * UNCONDITIONAL `update({ payment_status: 'paid', status: 'accepted' })` on each -- no check that
 * the reference was prepared for those orders or that venue, none that it had not already paid for
 * something, none on the orders' current state (cancelled -> paid worked), no ledger row and no
 * audit row on success.
 *
 * Now, in order:
 *
 *   1. every requested order is in the caller's venue, and none is cancelled or otherwise
 *      unclaimable (all already paid -> an idempotent no-op; a mix -> refused);
 *   2. the reference is BOUND to exactly these orders from server state (reconcile-reference.ts)
 *      and has not been CONSUMED by any recorded payment;
 *   3. Finatic says it was paid, for an amount that equals what the projection
 *      (lib/orders/order-financials.ts) says these orders still owe, plus the gratuity the
 *      prepared charge carried -- not orders.total, which keeps counting voided lines;
 *   4. the gateway transaction id is not already on another payment;
 *   5. the settlement is applied by settle_order_payment (via settleWholeOrderPayment): a locked,
 *      conditional claim from owing statuses only, the immutable gateway ledger row, the
 *      settlement audit row, settled_charge_cents (trigger), the intent consumed -- one transaction.
 *      A `payment.staff_reconciled` row per order records WHO did it.
 *
 * Authorization is unchanged: PAYMENTS_PROCESS in the caller's own venue.
 */

type Refusal = { code: string; error: string; status: number; extra?: Record<string, unknown> }

function refuse(r: Refusal) {
  return NextResponse.json(
    { ok: false, paid: false, applied: false, code: r.code, error: r.error, ...(r.extra ?? {}) },
    { status: r.status },
  )
}

const REFERENCE_REFUSAL_STATUS: Record<string, number> = {
  REFERENCE_UNKNOWN: 409,
  REFERENCE_NOT_FOR_RESTAURANT: 403,
  REFERENCE_NOT_FOR_THESE_ORDERS: 409,
  REFERENCE_ALREADY_CONSUMED: 409,
  REFERENCE_UNREADABLE: 503,
}

export async function POST(req: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.PAYMENTS_PROCESS, req)
    if (isAuthError(auth)) return auth

    const { supabase, restaurantId: callerRestaurantId, userId } = auth
    const body = await req.json().catch(() => ({}))
    const restaurantId = String(body.restaurantId || callerRestaurantId || '').trim()
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? [...new Set<string>(body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean))]
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

    // ---- 1. the orders, in THIS venue, projected -------------------------------------------
    let loaded: Awaited<ReturnType<typeof loadOrderFinancials>>
    try {
      loaded = await loadOrderFinancials(supabase, restaurantUuid, orderIds)
    } catch (e) {
      if (e instanceof FinancialsUnreadable) {
        return refuse({ code: 'ORDERS_UNREADABLE', error: e.message, status: 503 })
      }
      throw e
    }
    // Another venue's order is simply not found here, and that is a refusal of the whole request.
    if (loaded.rows.length !== orderIds.length) {
      const found = new Set(loaded.rows.map((r) => String(r.id)))
      return refuse({
        code: 'ORDERS_NOT_FOUND',
        error: 'One or more orders were not found',
        status: 404,
        extra: { missingOrderIds: orderIds.filter((id) => !found.has(id)) },
      })
    }

    const paidCount = loaded.rows.filter((r) => isPaidPaymentStatus(r.payment_status)).length
    if (paidCount === orderIds.length) {
      // IDEMPOTENT. A second reconciliation of a settled set writes nothing and says so.
      return NextResponse.json(
        { ok: true, paid: true, applied: false, outcome: 'already_paid', source: 'supabase' },
        { status: 200 },
      )
    }
    if (paidCount > 0) {
      return refuse({
        code: 'ORDERS_PARTIALLY_PAID',
        error: 'Some of these orders are already paid; reconcile the unpaid ones against their own reference.',
        status: 409,
      })
    }
    const unclaimable = loaded.rows.filter(
      (r) => String(r.status ?? '').toLowerCase() === 'cancelled' || !owesMoney(r.payment_status),
    )
    if (unclaimable.length > 0) {
      return refuse({
        code: 'ORDER_NOT_CLAIMABLE',
        error: 'A cancelled order, or one not in an owing state, cannot be reconciled to paid.',
        status: 409,
        extra: {
          orders: unclaimable.map((r) => ({ id: r.id, status: r.status, payment_status: r.payment_status })),
        },
      })
    }

    // ---- 2. the reference: bound to these orders, and unconsumed ----------------------------
    const { data: refRows, error: refError } = await supabase
      .from('orders')
      .select('id, paycloud_merchant_order_no, pending_tip_cents')
      .eq('restaurant_id', restaurantUuid)
      .in('id', orderIds)
    if (refError) return refuse({ code: 'ORDERS_UNREADABLE', error: refError.message, status: 503 })
    const refOrderRows = (refRows ?? []) as Array<Record<string, unknown>>
    const onOrders = [
      ...new Set(refOrderRows.map((r) => String(r.paycloud_merchant_order_no ?? '').trim()).filter(Boolean)),
    ]
    if (!merchantOrderNoRaw && onOrders.length > 1) {
      return refuse({
        code: 'REFERENCE_AMBIGUOUS',
        error: 'These orders carry more than one payment reference; name the one to reconcile.',
        status: 409,
      })
    }
    const merchantOrderNo = merchantOrderNoRaw || onOrders[0] || ''
    if (!merchantOrderNo) {
      return refuse({
        code: 'REFERENCE_UNKNOWN',
        error: 'No payment reference was prepared for these orders.',
        status: 409,
      })
    }

    const bound = await bindReferenceToOrders(supabase, {
      restaurantId: restaurantUuid,
      merchantOrderNo,
      orderIds,
    })
    if (!bound.ok) {
      return refuse({
        code: bound.code,
        error: `Reference ${merchantOrderNo} cannot be reconciled onto these orders (${bound.detail}).`,
        status: REFERENCE_REFUSAL_STATUS[bound.code] ?? 409,
        extra: { merchantOrderNo },
      })
    }

    const consumedBefore = await referenceConsumption(supabase, {
      restaurantId: restaurantUuid,
      merchantOrderNo,
      intent: bound.intent,
    })
    if (consumedBefore.consumed === null) {
      return refuse({ code: 'REFERENCE_UNREADABLE', error: consumedBefore.detail, status: 503 })
    }
    if (consumedBefore.consumed) {
      return refuse({
        code: 'REFERENCE_ALREADY_CONSUMED',
        error: `Reference ${merchantOrderNo} has already been applied (${consumedBefore.detail}).`,
        status: 409,
        extra: { merchantOrderNo, consumedBy: consumedBefore.by },
      })
    }

    // ---- 3. the gateway ----------------------------------------------------------------------
    let merchantNo: string
    let storeNo: string
    try {
      ;({ merchantNo, storeNo } = await getRestaurantFinaticCredentials(restaurantUuid))
    } catch (credErr) {
      if (!isMissingFinaticCredentialsError(credErr)) throw credErr
      return refuse({
        code: 'CREDENTIALS_NOT_CONFIGURED',
        error: 'This venue has no Finatic credentials; the gateway cannot be asked.',
        status: 400,
      })
    }

    let result: Awaited<ReturnType<typeof queryFinaticOrderPaid>>
    try {
      result = await queryFinaticOrderPaid({ merchantOrderNo, merchantNo, storeNo })
    } catch (queryErr) {
      if (!isFinaticMerchantOrderInvalidError(queryErr)) throw queryErr
      return NextResponse.json(
        { ok: true, paid: false, applied: false, source: 'query', status: 'no_gateway_record', merchantOrderNo },
        { status: 200 },
      )
    }

    if (!result.paid) {
      return NextResponse.json(
        { ok: true, paid: false, applied: false, source: 'query', status: result.status || 'unknown', merchantOrderNo },
        { status: 200 },
      )
    }

    /**
     * WHAT THESE ORDERS STILL OWE, from the projection, plus the gratuity the prepared charge
     * carried (the intent's, or Σ pending_tip_cents). Integer cents; exact; an absent gateway
     * amount is unverified, never agreed (#197 / #190, unchanged).
     */
    const outstandingCents = loaded.rows.reduce(
      (sum, r) => sum + (loaded.byId.get(String(r.id))?.outstandingCents ?? 0),
      0,
    )
    const tipCents = bound.intent
      ? bound.intent.tipCents
      : refOrderRows.reduce((sum, r) => sum + Math.max(0, Math.round(Number(r.pending_tip_cents ?? 0)) || 0), 0)
    const expectedCents = outstandingCents + tipCents
    const expectedAmount = expectedCents / 100
    const paidAmount = result.amount
    const gatewayCents = paidAmount === null ? null : Math.round(Number(paidAmount) * 100)
    const amountVerified = gatewayCents !== null && gatewayCents === expectedCents

    if (!amountVerified) {
      const error =
        paidAmount === null
          ? `Amount unverified. Finatic reports paid for ${merchantOrderNo} but returned no amount, ` +
            `so the expected ${expectedAmount.toFixed(2)} could not be confirmed.`
          : `Amount mismatch. Expected ${expectedAmount.toFixed(2)}, got ${Number(paidAmount).toFixed(2)}`
      console.error('[RECONCILE] refusing to mark paid:', error)

      /**
       * One payment.verification_uncertain row PER ORDER: the staff member sees the 409, but these
       * are charged customers whose orders stay unpaid, and the resolution procedure finds them by
       * entity_id on that action.
       */
      for (const orderId of orderIds) {
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
            expectedBasis: 'projection_outstanding_plus_tip',
            amountVerified: false,
            businessOrderNo: merchantOrderNo,
            batchOrderIds: orderIds,
            staffUserId: userId,
            source: 'staff_reconcile',
            outcome: 'left_pending_finatic_uncertain',
          },
        })
        if (uncertainAuditError) {
          console.error('[RECONCILE] payment.verification_uncertain audit failed:', uncertainAuditError)
        }
      }

      return NextResponse.json(
        {
          ok: false,
          paid: false,
          applied: false,
          code: 'AMOUNT_UNVERIFIED',
          error,
          outcome: 'left_pending_finatic_uncertain',
          expectedAmount,
          paidAmount,
        },
        { status: 409 },
      )
    }

    // ---- 4. the gateway transaction is not already another payment's --------------------------
    const consumedAfter = await referenceConsumption(supabase, {
      restaurantId: restaurantUuid,
      merchantOrderNo,
      intent: bound.intent,
      transactionId: result.transactionId,
    })
    if (consumedAfter.consumed === null) {
      return refuse({ code: 'REFERENCE_UNREADABLE', error: consumedAfter.detail, status: 503 })
    }
    if (consumedAfter.consumed) {
      return refuse({
        code: 'REFERENCE_ALREADY_CONSUMED',
        error: `The gateway transaction for ${merchantOrderNo} has already been applied (${consumedAfter.detail}).`,
        status: 409,
        extra: { merchantOrderNo, consumedBy: consumedAfter.by },
      })
    }

    // ---- 5. apply: one transaction, conditional, ledgered, audited ----------------------------
    const settled = await settleWholeOrderPayment(supabase, {
      restaurantId: restaurantUuid,
      leadOrderIds: bound.leadOrderIds,
      intent: bound.intent,
      merchantOrderNo,
      transactionId: result.transactionId,
      gatewayAmount: paidAmount,
      paymentMethod: 'card',
      source: 'staff_reconcile',
      mismatchSource: 'staff_reconcile',
      allowCancelledRecovery: false,
      // Pinned: the set bound and amount-checked above is the only set that may be settled.
      expectedOrderIds: orderIds,
      extraAuditMetadata: {
        staffUserId: userId,
        finaticStatus: result.status,
        finaticTransactionId: result.transactionId,
        finaticAmount: paidAmount,
        businessOrderNo: merchantOrderNo,
      },
    })

    if (!settled.ok) {
      const transient = settled.reason === 'rpc_failed' || settled.reason === 'target_unreadable'
      return refuse({
        code: `SETTLEMENT_${settled.reason.toUpperCase()}`,
        error: `The settlement was not applied (${settled.reason}).`,
        status: transient ? 503 : 409,
        extra: { outcome: 'left_pending_finatic_uncertain', merchantOrderNo },
      })
    }

    const applied = settled.applied && settled.claimedOrderIds.length > 0
    if (applied) {
      const { error: auditError } = await supabase.from('audit_logs').insert(
        settled.claimedOrderIds.map((orderId) => ({
          restaurant_id: restaurantUuid,
          action: 'payment.staff_reconciled',
          entity_type: 'order',
          entity_id: orderId,
          metadata: {
            staffUserId: userId,
            businessOrderNo: merchantOrderNo,
            gatewayTransactionId: result.transactionId,
            settlementGatewayAmountCents: gatewayCents,
            settlementExpectedAmountCents: expectedCents,
            intentId: bound.intent?.id ?? null,
            batchOrderIds: orderIds,
            source: 'staff_reconcile',
          },
        })),
      )
      // The settlement's own audit row is already committed inside the RPC; this one adds WHO.
      if (auditError) console.error('[RECONCILE] payment.staff_reconciled audit failed:', auditError)
    }

    return NextResponse.json(
      {
        ok: true,
        paid: true,
        applied,
        outcome: applied ? 'settled' : 'already_settled',
        source: 'query',
        merchantOrderNo,
        claimedOrderIds: settled.claimedOrderIds,
      },
      { status: 200 },
    )
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to reconcile payment'
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
