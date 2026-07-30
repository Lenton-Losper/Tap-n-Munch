import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { generatePaymentReference } from '@/lib/payment-reference'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import {
  amountsMatch,
  CLAIMABLE_PAYMENT_STATUSES,
  isClaimablePaymentStatus,
} from '@/lib/payments/payment-integrity'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params
    const body = await req.json().catch(() => ({}))

    const orderIds: string[] = Array.isArray(body.order_ids)
      ? body.order_ids.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const gatewayReference: string = body.gateway_reference ?? ''
    const voucherNo =
      body?.voucher_no != null && String(body.voucher_no).trim()
        ? String(body.voucher_no).trim()
        : body?.voucherNo != null && String(body.voucherNo).trim()
          ? String(body.voucherNo).trim()
          : ''
    const businessOrderNo =
      body?.business_order_no != null && String(body.business_order_no).trim()
        ? String(body.business_order_no).trim()
        : body?.businessOrderNo != null && String(body.businessOrderNo).trim()
          ? String(body.businessOrderNo).trim()
          : ''
    const amount: number = Number(body.amount)
    const method: string = body.method ?? 'card'

    if (!orderIds.length) {
      return NextResponse.json(
        { error: 'order_ids required' },
        { status: 400 }
      )
    }

    // Verify tab belongs to this restaurant
    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, table_id, total')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (tabError || !tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    // Bind order_ids to this tab + restaurant; never trust cross-tab IDs.
    const { data: tabOrders, error: tabOrdersError } = await supabase
      .from('orders')
      .select('id, total, payment_status')
      .eq('tab_id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .in('id', orderIds)

    if (tabOrdersError) {
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 })
    }

    const foundIds = new Set((tabOrders ?? []).map((o) => String(o.id)))
    const missing = orderIds.filter((id) => !foundIds.has(id))
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: 'order_ids must belong to this tab',
          code: 'ORDER_TAB_MISMATCH',
          invalid_order_ids: missing,
        },
        { status: 400 },
      )
    }

    // Partition the requested orders BEFORE computing any amount or touching the DB.
    //
    // Previously expectedAmount summed every requested order, including cancelled and
    // already-paid ones. A tab holding a pending order plus a previously-declined one
    // demanded the sum of BOTH, so a cashier sending the honest figure got AMOUNT_MISMATCH
    // and the only way to proceed was to charge the card for money that was not owed.
    const claimableOrders = (tabOrders ?? []).filter((o) =>
      isClaimablePaymentStatus(o.payment_status),
    )
    const nonClaimableOrders = (tabOrders ?? []).filter(
      (o) => !isClaimablePaymentStatus(o.payment_status),
    )

    // A genuine double-settle retry -- every requested order really is paid -- must keep
    // returning 409 ALREADY_PAID. The terminal maps that code to staff-facing copy; a
    // different code surfaces a raw string. This is checked BEFORE the amount comparison,
    // because a retry has no claimable orders and would otherwise expect 0 and be reported
    // as an amount mismatch.
    // Names the ACTUAL states rather than listing every possibility. Telling a cashier an
    // order was "already paid" when it was declined sends them looking for a payment that
    // never happened -- the old SETTLE_CLAIM_CONFLICT copy did exactly that.
    const describeNonClaimable = (rows: typeof nonClaimableOrders) => {
      const states = [
        ...new Set(
          rows.map((o) => String(o.payment_status ?? 'unknown').trim().toLowerCase()),
        ),
      ].sort()
      return `Some selected orders cannot be settled — their payment state is: ${states.join(', ')}`
    }

    if (claimableOrders.length === 0) {
      const allPaid = nonClaimableOrders.every(
        (o) => String(o.payment_status ?? '').trim().toLowerCase() === 'paid',
      )
      return NextResponse.json(
        {
          error: allPaid
            ? 'Orders are already paid'
            : describeNonClaimable(nonClaimableOrders),
          code: allPaid ? 'ALREADY_PAID' : 'NON_CLAIMABLE_ORDERS_IN_REQUEST',
          claimed_order_ids: [],
          non_claimable_order_ids: nonClaimableOrders.map((o) => String(o.id)),
        },
        { status: allPaid ? 409 : 400 },
      )
    }

    // Reject a mixed request before any write rather than silently settling a subset: the
    // device computed its charge from the set it sent, so quietly settling less would leave
    // the difference charged and unrecorded. The error names the offending orders instead of
    // claiming they were "already paid" -- a declined order never was.
    if (nonClaimableOrders.length > 0) {
      return NextResponse.json(
        {
          error: describeNonClaimable(nonClaimableOrders),
          code: 'NON_CLAIMABLE_ORDERS_IN_REQUEST',
          non_claimable_order_ids: nonClaimableOrders.map((o) => String(o.id)),
          claimable_order_ids: claimableOrders.map((o) => String(o.id)),
        },
        { status: 400 },
      )
    }

    // Derived from the claimable set by construction, so a non-claimable total can never
    // reach the card, the payments row, or the audit metadata.
    const expectedAmount = claimableOrders.reduce(
      (sum, o) => sum + Number(o.total),
      0,
    )
    if (!amountsMatch(amount, expectedAmount)) {
      return NextResponse.json(
        {
          error: 'amount does not match order totals',
          code: 'AMOUNT_MISMATCH',
          expected: expectedAmount,
          received: Number.isFinite(amount) ? amount : null,
        },
        { status: 400 },
      )
    }

    const paidAt = new Date().toISOString()
    const paymentReference = generatePaymentReference()
    const paymentVoucherNo = voucherNo || gatewayReference || null

    // Atomic claim: only unpaid/pending rows on this tab flip to paid.
    const { data: claimed, error: ordersError } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method: method,
        payment_reference: paymentReference,
        payment_voucher_no: paymentVoucherNo,
        status: 'completed',
        paid_at: paidAt,
        completed_at: paidAt,
      })
      .in('id', orderIds)
      .eq('tab_id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .in('payment_status', [...CLAIMABLE_PAYMENT_STATUSES])
      .select('id')

    if (ordersError) {
      return NextResponse.json(
        { error: 'Failed to update orders' },
        { status: 500 }
      )
    }

    const claimedIds = (claimed ?? []).map((o) => String(o.id))

    // Nothing was claimed, so nothing was mutated -- safe to bail with no compensation.
    // A concurrent settle took every order between our read and our claim.
    if (claimedIds.length === 0) {
      return NextResponse.json(
        {
          error: 'Orders are already paid',
          code: 'ALREADY_PAID',
          claimed_order_ids: [],
        },
        { status: 409 },
      )
    }

    // A SHORT CLAIM IS NOT AN ERROR, AND MUST NOT ABANDON THE WRITE.
    //
    // Previously any shortfall returned 409 here, after the claim had already flipped rows
    // to paid and stamped them with paymentReference -- and before the payments insert, the
    // audit log, receipts and the tab recalc, all of which live below. The card was charged
    // on the device before this endpoint was even called, so that left money taken with no
    // payments row, no receipt, no audit trail and no way to retry: every retry answered
    // "already paid". A cancelled order made it unconditional, because a cancelled row can
    // never satisfy the claim's CLAIMABLE_PAYMENT_STATUSES filter.
    //
    // Non-claimable orders are now rejected above, so a shortfall here means only one thing:
    // a genuine concurrent writer took some rows in the window between our read and our
    // claim. We own exactly the rows we claimed, so we settle exactly those and record them
    // completely. Rolling back instead would reproduce the original harm -- the device's
    // charge would stand with nothing recorded against it.
    const claimedSet = new Set(claimedIds)
    const settledAmount = claimableOrders
      .filter((o) => claimedSet.has(String(o.id)))
      .reduce((sum, o) => sum + Number(o.total), 0)

    const lostToConcurrentClaim = claimableOrders
      .filter((o) => !claimedSet.has(String(o.id)))
      .map((o) => String(o.id))

    if (lostToConcurrentClaim.length > 0) {
      // Surfaced rather than silently succeeded: the device charged `amount`, we could only
      // record `settledAmount`, and the difference needs a human.
      console.error('[TAB-SETTLE] partial claim — charged amount exceeds settled amount', {
        tabId,
        paymentReference,
        chargedAmount: amount,
        settledAmount,
        claimedIds,
        lostToConcurrentClaim,
      })
    }

    if (businessOrderNo) {
      await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: businessOrderNo.slice(0, 32) })
        .in('id', claimedIds)
        .eq('restaurant_id', terminal.restaurantId)
        .is('paycloud_merchant_order_no', null)
    }

    await safeIssueReceiptsForOrders(claimedIds, 'terminal/tabs/settle')

    // Recalculate tab total from remaining unpaid orders
    const { data: unpaidOrders } = await supabase
      .from('orders')
      .select('total')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')

    const newTotal = (unpaidOrders ?? []).reduce(
      (sum, o) => sum + Number(o.total), 0
    )

    await supabase
      .from('tabs')
      .update({ total: newTotal })
      .eq('id', tabId)

    // Create payment record (server amount, not client)
    await supabase.from('payments').insert({
      restaurant_id: terminal.restaurantId,
      table_id: tab.table_id,
      tab_id: tabId,
      order_ids: claimedIds,
      // settledAmount, not expectedAmount: the recorded amount must describe the rows this
      // request actually claimed, so the ledger can never overstate what was settled.
      amount: settledAmount,
      method,
      status: 'completed',
      gateway_reference: gatewayReference,
      payment_reference: paymentReference,
      completed_at: paidAt,
    })

    // Audit log
    await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: 'payment.tab_settled',
      entity_type: 'tabs',
      entity_id: tabId,
      metadata: {
        order_ids: claimedIds,
        amount: settledAmount,
        client_amount: amount,
        method,
        payment_reference: paymentReference,
        terminal_id: terminal.terminalId,
        // Non-empty only on a concurrent short claim: the device charged client_amount but
        // only settledAmount could be recorded. Present so the discrepancy is auditable.
        lost_to_concurrent_claim: lostToConcurrentClaim,
      },
    })

    // canClose check
    const { data: remaining } = await supabase
      .from('orders')
      .select('id')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')

    const canClose = (remaining ?? []).length === 0

    await supabase
      .from('tabs')
      .update({
        status: 'open',
        payment_preference: null,
        ready_to_pay_at: null,
      })
      .eq('id', tabId)

    return NextResponse.json({
      success: true,
      payment_reference: paymentReference,
      new_tab_total: newTotal,
      can_close: canClose,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
