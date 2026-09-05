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
 * - CONSUMES A CASH-AUTHORIZATION TOKEN, since 2026-09-03, by the same mechanism and against the
 *   same 'cash_settlement' purpose as the whole-order route. This used to read "does not... and
 *   staff_user_id is recorded when supplied, unverified", which meant the append-only settlements
 *   ledger could name a member of staff who authorised nothing, on a row that cannot be corrected.
 * - IMPLEMENTS THE CARD-IN-FLIGHT GUARD, since 2026-09-03. This used to read "that guard exists
 *   for a card payment race specific to per-order settlement's push/poll flow, which this route
 *   does not use." That reasoning was wrong in the direction that costs a customer money: the race
 *   belongs to the ORDER, not to the flow. If a card attempt is live on order X and the gateway may
 *   still answer yes, taking cash against X charges twice — whether the cash covered the whole
 *   order or one diner's share of it. Scoped to the orders the allocations touch, so splitting
 *   Sam's dish is not blocked by a card in flight elsewhere on the same tab.
 * - Resolving `allocated_to` (a member name) to its live, unsettled allocation ids on this tab
 *   is done here in the route, not in the RPC, so the RPC's own contract stays "a list of
 *   allocation ids", matching amend_order_lines()'s own "trusts its caller" convention.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { generatePaymentReference } from '@/lib/payment-reference'
import { parseTipCents, recordTip } from '@/lib/payments/tips'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import {
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  isCardPaymentStillInFlight,
  normalizeSettlementPaymentMethod,
  owesMoney,
  roundToCents,
  secondsSincePush,
} from '@/lib/payments/payment-integrity'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
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
      staffUserId?: unknown
      authorization_token_id?: unknown
      authorizationTokenId?: unknown
    }

    const method = normalizeSettlementPaymentMethod(body.method ?? 'cash')
    if (!method) {
      return NextResponse.json(
        { error: 'Unsupported payment method', code: 'UNSUPPORTED_PAYMENT_METHOD', received: body.method ?? null },
        { status: 400 },
      )
    }
    const isCashSettlement = method === 'cash'

    /**
     * THE GRATUITY. Same contract as the whole-tab settle route: integer cents, its own field,
     * never folded into an amount this route validates. See lib/payments/tips.ts for why a
     * voluntary gratuity is not consideration for the supply and therefore not part of the bill.
     */
    const tipParse = parseTipCents((body as { tip_cents?: unknown; tipCents?: unknown }).tip_cents ??
      (body as { tipCents?: unknown }).tipCents)
    if (!tipParse.ok) {
      return NextResponse.json({ error: tipParse.message, code: tipParse.code }, { status: 400 })
    }
    const tipCents = tipParse.tipCents

    /**
     * WHO IS TAKING THE CASH — the gap this route's own header declared:
     * "Does not consume a cash-authorization token the way the whole-order settle route does."
     *
     * Closed with the SAME mechanism, not a second one. Optional in exactly the same way: there is
     * no hard approval gate today, so a terminal that cannot yet prompt for a PIN is not locked
     * out of splitting a bill. But when a token IS supplied it is verified and single-use-consumed
     * against purpose 'cash_settlement', and the audit records which of the two actually happened
     * rather than implying an attribution nobody proved.
     *
     * Previously this route passed `body.staff_user_id` straight into the RPC, UNVERIFIED and by
     * its own admission. That meant the ledger could name a member of staff who never authorised
     * anything, on a row that is append-only and therefore uncorrectable.
     */
    const staffUserId = String(body.staff_user_id ?? body.staffUserId ?? '').trim()
    const authorizationTokenId = String(
      body.authorization_token_id ?? body.authorizationTokenId ?? '',
    ).trim()

    if (authorizationTokenId && !staffUserId) {
      return NextResponse.json(
        {
          error: 'staff_user_id is required when authorization_token_id is supplied',
          code: 'ATTRIBUTION_INCOMPLETE',
        },
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

    /**
     * ============================================================================================
     * CARD-IN-FLIGHT GUARD — the second gap this route's header declared
     * ============================================================================================
     *
     * The header said this route "does not implement the whole-order route's card-in-flight guard:
     * that guard exists for a card payment race that is specific to per-order settlement's own
     * push/poll flow, which this route does not use."
     *
     * That reasoning is wrong, and it is wrong in the direction that costs a customer money. The
     * race is not a property of the push/poll FLOW, it is a property of the ORDER: if a card
     * attempt is live on order X and the gateway may still answer yes, then taking cash against
     * order X charges the customer twice. It makes no difference whether the cash was collected
     * for the whole order or for one diner's share of it — the same order gets paid twice.
     *
     * SCOPED TO THE ORDERS THESE ALLOCATIONS TOUCH, not the whole tab. That is the one real
     * difference from the whole-order route: settling Sam's dish must not be refused because a
     * card is in flight on a different order at the same table that nobody is splitting.
     *
     * Time-bounded identically. Past CARD_IN_FLIGHT_TIMEOUT_SECONDS the attempt is treated as dead
     * and cash is allowed again, so a crashed reader cannot strand a table forever.
     */
    const { data: allocationOrders, error: allocationOrdersError } = await supabase
      .from('order_line_allocations')
      .select('order_id')
      .in('id', allocationIds)
      .eq('restaurant_id', terminal.restaurantId)
    if (allocationOrdersError) {
      console.error('[terminal/tabs/settle-allocations] could not resolve allocation orders', allocationOrdersError)
      return NextResponse.json({ error: 'Could not read these allocations' }, { status: 500 })
    }
    const affectedOrderIds = [...new Set((allocationOrders ?? []).map((r) => String(r.order_id)))]

    const settleNow = new Date()
    if (isCashSettlement && affectedOrderIds.length > 0) {
      const { data: affectedOrders, error: affectedOrdersError } = await supabase
        .from('orders')
        .select('id, payment_status, terminal_pushed_at')
        .in('id', affectedOrderIds)
        .eq('restaurant_id', terminal.restaurantId)
      if (affectedOrdersError) {
        // FAILS CLOSED. Not being able to read the payment state is not permission to take cash
        // against an order that might have a card in flight.
        console.error('[terminal/tabs/settle-allocations] in-flight check failed', affectedOrdersError)
        return NextResponse.json(
          { error: 'Could not confirm no card payment is in progress', code: 'IN_FLIGHT_CHECK_FAILED' },
          { status: 503 },
        )
      }

      const stillInFlight = (affectedOrders ?? []).filter((o) =>
        isCardPaymentStillInFlight(
          String(o.payment_status ?? '').trim().toLowerCase(),
          o.terminal_pushed_at,
          settleNow,
        ),
      )
      if (stillInFlight.length > 0) {
        const waits = stillInFlight.map((o) => ({
          order_id: String(o.id),
          seconds_since_push: Math.round(secondsSincePush(o.terminal_pushed_at, settleNow) ?? 0),
        }))
        return NextResponse.json(
          {
            error:
              'A card payment is in progress for part of this bill. Wait for it to finish, or cancel it on the terminal, then take cash.',
            code: 'CARD_PAYMENT_IN_FLIGHT',
            order_ids: stillInFlight.map((o) => String(o.id)),
            in_flight: waits,
            retry_after_seconds: Math.max(
              1,
              Math.ceil(
                CARD_IN_FLIGHT_TIMEOUT_SECONDS - Math.min(...waits.map((w) => w.seconds_since_push)),
              ),
            ),
          },
          { status: 409 },
        )
      }
    }

    /**
     * VERIFIED BEFORE THE MONEY MOVES, for the same reason the whole-order route does it here: a
     * rejected token must not leave allocations settled with a member of staff credited who never
     * authorised it. The settlements ledger is append-only, so a wrong attribution cannot be
     * edited out afterwards.
     *
     * Fails closed on a thrown error as well as a rejected token — consuming a token also writes
     * an authorization_events row, and letting that write escape would land in the generic catch
     * and answer 401, which tells staff nothing about why the cash was refused.
     */
    let attributedStaffUserId: string | null = null
    if (authorizationTokenId) {
      let consumed: Awaited<ReturnType<typeof consumeAuthorizationToken>>
      try {
        consumed = await consumeAuthorizationToken(supabase, {
          tokenId: authorizationTokenId,
          expectedUserId: staffUserId,
          expectedRestaurantId: terminal.restaurantId,
          expectedTerminalId: terminal.terminalId,
          expectedPurpose: 'cash_settlement',
        })
      } catch (authErr) {
        console.error('[terminal/tabs/settle-allocations] authorization check failed', authErr)
        consumed = { ok: false, reason: 'not_found' }
      }

      if (!consumed.ok) {
        return NextResponse.json(
          { error: 'Authorization could not be verified', code: 'AUTHORIZATION_INVALID', reason: consumed.reason },
          { status: 403 },
        )
      }
      attributedStaffUserId = staffUserId
    }

    /**
     * A GRATUITY NEEDS A NAME, refused BEFORE the RPC so nothing is half-settled.
     *
     * Identical rule to the whole-tab settle route, and for the same reason:
     * payment_tips.staff_user_id is NOT NULL, attribution comes from the authorization token, and
     * this route does not require one either. Taking the gratuity and dropping it would be money
     * recorded as nobody's; recording it unattributed defeats the table.
     *
     * A settlement with NO tip is unaffected.
     */
    if (tipCents > 0 && !attributedStaffUserId) {
      return NextResponse.json(
        {
          error:
            'A gratuity has to be recorded against the staff member taking it, so this settlement ' +
            'needs a staff PIN. Authorize and try again, or settle without the gratuity.',
          code: 'TIP_NEEDS_ATTRIBUTION',
          tip_cents: tipCents,
        },
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
      // The VERIFIED attribution, or null. Never the raw body field: an unverified staff id on an
      // append-only ledger row is a claim about who took cash that nobody can retract afterwards.
      p_staff_user_id: attributedStaffUserId,
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

    /**
     * THE GRATUITY, recorded against the settlement that carried it.
     *
     * WHY A RE-READ RATHER THAN THE RPC'S RETURN. `settle_order_line_allocations` answers
     * `{applied, refused}` with allocation ids and amounts -- not the settlement row ids it just
     * wrote. Widening that function's return is a migration against an RPC both paths depend on,
     * which is a bigger change than this needs, so the rows are found by the `payment_reference`
     * this call generated. That reference is unique per settle, so the re-read cannot pick up an
     * earlier settlement's rows.
     *
     * WHY THE FIRST ROW. A split settle writes ONE settlement row PER ALLOCATION, but the customer
     * gave ONE gratuity for the whole transaction -- there is no per-allocation share of it, and
     * inventing one by dividing would be fabricating a number nobody agreed. The tip is a single
     * row naming a representative settlement; `payment_reference` is what ties the group together
     * if the whole event ever needs reconstructing.
     *
     * *** A DESIGN CHOICE WORTH REVISITING: if a tip should belong to the settle EVENT rather than
     * *** to one of its rows, the cleaner model is payment_tips.payment_reference. The migration is
     * *** not applied anywhere yet, so that change is still cheap.
     */
    let tipOutcome: string | null = null
    if (tipCents > 0) {
      const { data: settlementRows, error: settlementReadError } = await supabase
        .from('order_line_allocation_settlements')
        .select('id')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('payment_reference', paymentReference)
        .order('settled_at', { ascending: true })
        .limit(1)

      const settlementId = settlementRows?.[0]?.id ? String(settlementRows[0].id) : null
      if (settlementReadError || !settlementId) {
        // The allocations ARE settled -- the RPC succeeded. Only the gratuity could not be
        // attached, so this is reported, never thrown: the customer has paid.
        tipOutcome = 'not_recorded_no_settlement_row'
        console.error('[terminal/tabs/settle-allocations] gratuity could not be recorded', {
          tabId,
          tip_cents: tipCents,
          payment_reference: paymentReference,
          error: settlementReadError,
        })
      } else {
        const tip = await recordTip(supabase, {
          restaurantId: terminal.restaurantId,
          tipCents,
          method: isCashSettlement ? 'cash' : 'card',
          // Non-null by the TIP_NEEDS_ATTRIBUTION gate above, which refuses before the RPC.
          staffUserId: String(attributedStaffUserId),
          tabId,
          allocationSettlementId: settlementId,
        })
        tipOutcome = tip.recorded ? 'recorded' : tip.reason
        if (!tip.recorded && tip.reason === 'failed') {
          console.error('[terminal/tabs/settle-allocations] gratuity insert failed', {
            tabId,
            tip_cents: tipCents,
            error: tip.error,
          })
        }
      }
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
        // Which of the two actually happened, rather than implying an attribution nobody proved.
        staff_user_id: attributedStaffUserId,
        authorization_token_id: authorizationTokenId || null,
        attribution: attributedStaffUserId ? 'authorized' : 'unattributed',
        // Only when a gratuity was keyed, so an absent key means "no tip" and never "a tip we
        // lost". Any value other than 'recorded' means one was taken and needs reconciling.
        ...(tipCents > 0 ? { tip_cents: tipCents, tip_recorded: tipOutcome, tip_method: isCashSettlement ? 'cash' : 'card' } : {}),
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
      // Same contract as the audit entry: absent means no gratuity was keyed. The settlement
      // succeeded either way, so this is a reconciliation flag and not an error status.
      ...(tipCents > 0 ? { tip_cents: tipCents, tip_recorded: tipOutcome } : {}),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle-allocations]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
