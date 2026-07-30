import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { generatePaymentReference } from '@/lib/payment-reference'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import {
  amountsMatch,
  CLAIMABLE_PAYMENT_STATUSES,
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

    // Verify tab belongs to this restaurant.
    // status/settled_at are selected so the reopen at the end of this route can tell an
    // active tab from one that has already been closed out.
    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, table_id, total, status, settled_at')
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

    const expectedAmount = (tabOrders ?? []).reduce(
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
    if (claimedIds.length !== orderIds.length) {
      return NextResponse.json(
        {
          error:
            claimedIds.length === 0
              ? 'Orders are already paid'
              : 'Settle conflict — some orders were already paid',
          code:
            claimedIds.length === 0
              ? 'ALREADY_PAID'
              : 'SETTLE_CLAIM_CONFLICT',
          claimed_order_ids: claimedIds,
        },
        { status: 409 },
      )
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
      amount: expectedAmount,
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
        amount: expectedAmount,
        client_amount: amount,
        method,
        payment_reference: paymentReference,
        terminal_id: terminal.terminalId,
      },
    })

    // canClose check
    const { data: remaining } = await supabase
      .from('orders')
      .select('id')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')

    const canClose = (remaining ?? []).length === 0

    // Reopen the tab for continued ordering -- but NEVER resurrect a tab that has already
    // been closed out.
    //
    // This write used to be unconditional. A tab closed via close_table_session carries
    // status='settled' with settled_at/settled_type set; flipping it back to 'open' left a
    // contradictory row (open, yet settled minutes earlier) and, far worse, re-armed the
    // partial unique index idx_tabs_one_open_per_table UNIQUE (restaurant_id, table_number)
    // WHERE status='open' (supabase/schema.sql:1797). With an 'open' row present, a fresh
    // insert for that table is impossible, so POST /api/tabs hits 23505 and silently
    // degrades into a JOIN -- handing the NEXT customer the previous party's tab, complete
    // with their name, itemised order and receipt, and bypassing the tab PIN because that
    // path believes it is creating rather than joining.
    //
    // The guard is `.is('settled_at', null)` in the statement itself rather than a JS check,
    // so a close landing concurrently cannot slip through the window. A normal open or
    // ready_to_pay tab has settled_at null and still reopens, which is the intended
    // "settle, then keep ordering" behaviour.
    const tabWasClosedOut = tab.settled_at != null

    const { error: reopenError } = await supabase
      .from('tabs')
      .update({
        status: 'open',
        payment_preference: null,
        ready_to_pay_at: null,
      })
      .eq('id', tabId)
      .is('settled_at', null)

    if (reopenError) {
      console.error('[TAB-SETTLE] failed to reopen tab', { tabId, error: reopenError })
    } else if (tabWasClosedOut) {
      // Not an error: the payment above is fully recorded. The tab was closed out, so it
      // stays closed and the table remains free for the next party.
      console.log('[TAB-SETTLE] tab already closed out — not reopening', {
        tabId,
        status: tab.status,
        settledAt: tab.settled_at,
      })
    }

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
