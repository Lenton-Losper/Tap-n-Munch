/**
 * POST /api/terminal/tabs/{tabId}/settle-allocations -- item-level bill splitting, the SETTLE
 * side. docs/design-item-level-bill-splitting.md point 4: "A NEW settle mode, 'settle by
 * allocation', alongside today's 'settle by order_ids'... takes a set of order_line_allocation
 * ids (or a member identifier and settles everything allocated to them)."
 *
 * ============================================================================================
 * WHAT THIS DOES NOT TOUCH
 * ============================================================================================
 *
 * This route NEVER writes to orders.total, orders.items, or any other financial field on an
 * existing orders row to reflect a partial payment. The only order-level write it makes is the
 * SAME one-time terminal flip POST /api/terminal/tabs/[tabId]/settle already performs
 * (payment_status/status/paid_at/completed_at), and only once, and only when
 * order_is_fully_paid_by_allocations() -- a SQL-level, integer-cent predicate, not a guess made
 * in this route -- says every line on that order is fully paid. That is not a rewrite of a
 * part-paid order; it is the same terminal transition every whole-order settlement already does,
 * gated by a different completeness check.
 *
 * The money itself is recorded exclusively in the append-only
 * order_line_allocation_settlements ledger, written inside settle_order_line_allocations() --
 * see that function and its migration for the claim/race-safety reasoning.
 *
 * ============================================================================================
 * SCOPE, STATED PLAINLY
 * ============================================================================================
 *
 * - Requires station_screens_enabled, same as amend and the allocate route (order_lines only
 *   exists there).
 * - Does not consume a cash-authorization token the way the whole-order settle route does --
 *   that mechanism is per-order-settlement UX this feature does not yet have a design for, and
 *   inventing one was not asked for. staff_user_id is recorded when supplied, unverified.
 * - Does not implement the whole-order route's card-in-flight guard: that guard exists for a
 *   card payment race that is specific to per-order settlement's own push/poll flow, which this
 *   route does not use.
 * - Resolving `allocated_to` (a member name) to its live, unsettled allocation ids on this tab
 *   is done here in the route, not in the RPC, so the RPC's own contract stays "a list of
 *   allocation ids", matching amend_order_lines()'s own "trusts its caller" convention.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { generatePaymentReference } from '@/lib/payment-reference'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import { normalizeSettlementPaymentMethod, owesMoney, roundToCents } from '@/lib/payments/payment-integrity'
import { clearReadyToPayAndReopenTab } from '@/lib/tabs/settle-tab-state'
import { fromCents } from '@/lib/billing/split-cents'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      allocation_ids?: unknown
      allocated_to?: unknown
      method?: unknown
      gateway_reference?: unknown
      staff_user_id?: unknown
    }

    const method = normalizeSettlementPaymentMethod(body.method ?? 'cash')
    if (!method) {
      return NextResponse.json(
        { error: 'Unsupported payment method', code: 'UNSUPPORTED_PAYMENT_METHOD', received: body.method ?? null },
        { status: 400 },
      )
    }

    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, table_id, status, settled_at')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()
    if (tabError || !tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    let allocationIds: string[] = Array.isArray(body.allocation_ids)
      ? body.allocation_ids.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []

    const allocatedTo = String(body.allocated_to ?? '').trim()
    if (allocationIds.length === 0 && allocatedTo) {
      const { data: forMember, error: memberError } = await supabase
        .from('order_line_allocations')
        .select('id')
        .eq('tab_id', tabId)
        .eq('restaurant_id', terminal.restaurantId)
        .eq('allocated_to', allocatedTo)
        .is('voided_at', null)
        .is('settled_at', null)
      if (memberError) {
        return NextResponse.json({ error: 'Failed to look up allocations for this member' }, { status: 500 })
      }
      allocationIds = (forMember ?? []).map((r) => String(r.id))
    }

    if (allocationIds.length === 0) {
      return NextResponse.json(
        { error: 'allocation_ids (or allocated_to) must resolve to at least one allocation', code: 'NO_ALLOCATIONS' },
        { status: 400 },
      )
    }

    const paymentReference = generatePaymentReference()
    const { data: rpcData, error: rpcError } = await supabase.rpc('settle_order_line_allocations', {
      p_restaurant_id: terminal.restaurantId,
      p_tab_id: tabId,
      p_allocation_ids: allocationIds,
      p_method: method,
      p_payment_reference: paymentReference,
      p_staff_user_id: String(body.staff_user_id ?? '').trim() || null,
    })

    if (rpcError) {
      console.error('[terminal/tabs/settle-allocations] RPC failed', rpcError)
      return NextResponse.json({ error: 'Could not settle these allocations', code: 'SETTLE_ALLOCATIONS_FAILED' }, { status: 502 })
    }

    const result = rpcData as {
      applied: Array<{ allocation_id: string; amount_cents: number }>
      refused: Array<{ allocation_id: string; reason: string }>
    }

    if (result.applied.length === 0) {
      return NextResponse.json(
        { error: 'No allocations could be settled', code: 'NOTHING_SETTLED', refused: result.refused },
        { status: 409 },
      )
    }

    // Which orders did the just-applied allocations belong to? Each may now be fully paid.
    const { data: appliedRows, error: appliedRowsError } = await supabase
      .from('order_line_allocations')
      .select('id, order_id')
      .in(
        'id',
        result.applied.map((a) => a.allocation_id),
      )
    if (appliedRowsError) {
      console.error('[terminal/tabs/settle-allocations] could not re-read applied allocations', appliedRowsError)
    }
    const orderIds = [...new Set((appliedRows ?? []).map((r) => String(r.order_id)))]

    const completedOrderIds: string[] = []
    for (const orderId of orderIds) {
      const { data: fullyPaid, error: fullyPaidError } = await supabase.rpc('order_is_fully_paid_by_allocations', {
        p_order_id: orderId,
      })
      if (fullyPaidError) {
        console.error('[terminal/tabs/settle-allocations] fully-paid check failed', { orderId, error: fullyPaidError })
        continue
      }
      if (fullyPaid !== true) continue

      const paidAt = new Date().toISOString()
      // Same terminal transition POST /api/terminal/tabs/[tabId]/settle performs -- see header.
      // Guarded so this can only fire once per order (a second allocation settlement on an
      // already-completed order finds nothing to claim and is a no-op, not a re-write).
      const { data: claimed, error: claimError } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          payment_method: method,
          payment_reference: paymentReference,
          status: 'completed',
          paid_at: paidAt,
          completed_at: paidAt,
        })
        .eq('id', orderId)
        .eq('restaurant_id', terminal.restaurantId)
        .not('payment_status', 'eq', 'paid')
        .select('id')
      if (claimError) {
        console.error('[terminal/tabs/settle-allocations] order completion write failed', { orderId, error: claimError })
        continue
      }
      if ((claimed ?? []).length > 0) completedOrderIds.push(orderId)
    }

    if (completedOrderIds.length > 0) {
      await safeIssueReceiptsForOrders(completedOrderIds, 'terminal/tabs/settle-allocations')
    }

    const { data: tabOrderRows, error: unpaidError } = await supabase
      .from('orders')
      .select('total, payment_status')
      .eq('tab_id', tabId)

    let newTotal: number | null = null
    if (!unpaidError) {
      const recalculated = roundToCents(
        (tabOrderRows ?? []).filter((o) => owesMoney(o.payment_status)).reduce((sum, o) => sum + Number(o.total), 0),
      )
      const { error: totalWriteError } = await supabase.from('tabs').update({ total: recalculated }).eq('id', tabId)
      if (totalWriteError) {
        console.error('[terminal/tabs/settle-allocations] tab total write failed', { tabId, error: totalWriteError })
      } else {
        newTotal = recalculated
      }
    }

    const appliedAmountCents = result.applied.reduce((sum, a) => sum + a.amount_cents, 0)
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: 'payment.tab_settled_by_allocation',
      entity_type: 'tabs',
      entity_id: tabId,
      metadata: {
        allocation_ids: allocationIds,
        applied: result.applied,
        refused: result.refused,
        amount: fromCents(appliedAmountCents),
        method,
        payment_reference: paymentReference,
        terminal_id: terminal.terminalId,
        device_serial: terminal.deviceSerial,
        completed_order_ids: completedOrderIds,
        settled_at: new Date().toISOString(),
      },
    })
    if (auditError) {
      console.error('[terminal/tabs/settle-allocations] audit log insert failed', auditError)
    }

    await clearReadyToPayAndReopenTab(supabase, {
      tabId,
      logPrefix: '[terminal/tabs/settle-allocations]',
      tabWasClosedOut: tab.settled_at != null,
      reason: 'money_taken',
    })

    return NextResponse.json({
      success: true,
      payment_reference: paymentReference,
      method,
      applied: result.applied,
      refused: result.refused,
      completed_order_ids: completedOrderIds,
      new_tab_total: newTotal,
      tab_total_stale: newTotal === null,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle-allocations]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
