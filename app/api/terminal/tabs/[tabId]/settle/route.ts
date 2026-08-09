import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { generatePaymentReference } from '@/lib/payment-reference'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import {
  amountsMatch,
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  isCardPaymentStillInFlight,
  owesMoney,
  secondsSincePush,
  normalizeSettlementPaymentMethod,
  settleableStatusesForMethod,
} from '@/lib/payments/payment-integrity'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { clearReadyToPayAndReopenTab } from '@/lib/tabs/settle-tab-state'

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

    // Unrecognised methods are rejected, never defaulted -- a typo must not book as a card sale.
    const method = normalizeSettlementPaymentMethod(body.method ?? 'card')
    if (!method) {
      return NextResponse.json(
        {
          error: 'Unsupported payment method',
          code: 'UNSUPPORTED_PAYMENT_METHOD',
          received: body.method ?? null,
        },
        { status: 400 },
      )
    }
    const isCashSettlement = method === 'cash'

    // Who is taking the cash. Optional by design -- there is no hard approval gate today, so a
    // terminal that cannot yet prompt for a PIN is not locked out of settling. When the terminal
    // does supply a token it is verified and single-use-consumed, and the audit records exactly
    // which of the two happened rather than implying an attribution that was never proven.
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
      .select('id, total, payment_status, terminal_pushed_at')
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

    const settleableStatuses = settleableStatusesForMethod(method)
    const statusOf = (o: { payment_status: unknown }) =>
      String(o.payment_status ?? '').trim().toLowerCase()

    // A card payment in flight is the one case cash must refuse: the gateway may still answer
    // yes, and collecting cash alongside it charges the customer twice. Reported separately
    // from "already paid" so staff are told what to do rather than hitting a dead end.
    //
    // The block is time-bounded. Past CARD_IN_FLIGHT_TIMEOUT_SECONDS the attempt is treated as
    // dead -- terminal crashed, reader abandoned, push never surfaced -- and cash is allowed
    // again, so a stuck attempt cannot strand the table indefinitely.
    const settleNow = new Date()
    const inFlightCutoffIso = new Date(
      settleNow.getTime() - CARD_IN_FLIGHT_TIMEOUT_SECONDS * 1000,
    ).toISOString()
    const expiredInFlightSeconds: number[] = []

    if (isCashSettlement) {
      const stillInFlight = (tabOrders ?? []).filter((o) =>
        isCardPaymentStillInFlight(statusOf(o), o.terminal_pushed_at, settleNow),
      )
      if (stillInFlight.length > 0) {
        const waits = stillInFlight.map((o) => ({
          order_id: String(o.id),
          seconds_since_push: Math.round(secondsSincePush(o.terminal_pushed_at, settleNow) ?? 0),
        }))
        return NextResponse.json(
          {
            error:
              'A card payment is in progress for part of this selection. Wait for it to finish, or cancel it on the terminal, then take cash.',
            code: 'CARD_PAYMENT_IN_FLIGHT',
            order_ids: stillInFlight.map((o) => String(o.id)),
            in_flight: waits,
            // So the terminal can show a countdown rather than an unexplained refusal.
            retry_after_seconds: Math.max(
              1,
              Math.ceil(
                CARD_IN_FLIGHT_TIMEOUT_SECONDS -
                  Math.min(...waits.map((w) => w.seconds_since_push)),
              ),
            ),
          },
          { status: 409 },
        )
      }

      // Anything still terminal_pending here is past the timeout. Recorded so the audit trail
      // shows how long the dead attempt had been hanging when cash was taken -- the evidence
      // needed to retune the timeout against real behaviour.
      for (const o of tabOrders ?? []) {
        if (statusOf(o) === 'terminal_pending') {
          expiredInFlightSeconds.push(
            Math.round(secondsSincePush(o.terminal_pushed_at, settleNow) ?? -1),
          )
        }
      }
    }

    // Reject non-settleable orders BEFORE any write. Previously expectedAmount summed every
    // requested order regardless of status, so including an already-paid order inflated the
    // expected total, the amount check passed, and the claim then silently skipped that order --
    // taking money for an order that was already paid for. Validating up front also means the
    // claim below should always match in full; the mismatch branch is now a genuine race guard.
    // For cash, an EXPIRED terminal_pending order is settleable — the live ones were already
    // rejected above, so anything of that status reaching here is past the timeout.
    const isSettleableHere = (o: { payment_status: unknown }) =>
      settleableStatuses.includes(statusOf(o)) ||
      (isCashSettlement && statusOf(o) === 'terminal_pending')

    const notSettleable = (tabOrders ?? []).filter((o) => !isSettleableHere(o))
    if (notSettleable.length > 0) {
      const allPaid = notSettleable.every((o) => statusOf(o) === 'paid')
      return NextResponse.json(
        {
          error: allPaid
            ? 'Those orders have already been paid.'
            : 'Some orders in this selection cannot be settled.',
          code: allPaid ? 'ALREADY_PAID' : 'NOT_SETTLEABLE',
          order_ids: notSettleable.map((o) => String(o.id)),
          statuses: notSettleable.map((o) => ({
            order_id: String(o.id),
            payment_status: statusOf(o),
          })),
        },
        { status: 409 },
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

    // Verify the attribution before taking the money, so a rejected token cannot leave the
    // orders settled with a staff member credited who never authorized it.
    let attributedStaffUserId: string | null = null
    if (authorizationTokenId) {
      // Fails closed on a thrown error as well as a rejected token. Consuming the token also
      // writes an authorization_events row, and that write can itself fail (e.g. a staff id
      // that is not a real user); letting it escape would land in the generic catch below and
      // answer 401 Unauthorized, which tells staff nothing about why the cash was refused.
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
        console.error('[terminal/tabs/settle] authorization check failed', authErr)
        consumed = { ok: false, reason: 'not_found' }
      }

      if (!consumed.ok) {
        return NextResponse.json(
          {
            error: 'Authorization could not be verified',
            code: 'AUTHORIZATION_INVALID',
            reason: consumed.reason,
          },
          { status: 403 },
        )
      }
      attributedStaffUserId = staffUserId
    }

    const paidAt = new Date().toISOString()
    const paymentReference = generatePaymentReference()
    // Cash never carries a gateway artifact. Letting a stale voucher/gateway reference ride
    // along would print a card-style reference on a cash receipt.
    const paymentVoucherNo = isCashSettlement ? null : voucherNo || gatewayReference || null

    // Atomic claim: only rows still settleable by THIS method flip to paid. Cash may claim
    // cash_pending/failed orders; card keeps its original narrower set.
    let claimQuery = supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method: method,
        payment_reference: paymentReference,
        payment_voucher_no: paymentVoucherNo,
        status: 'completed',
        paid_at: paidAt,
        completed_at: paidAt,
        // The card attempt, live or dead, is over once the order is settled.
        terminal_pushed_at: null,
      })
      .in('id', orderIds)
      .eq('tab_id', tabId)
      .eq('restaurant_id', terminal.restaurantId)

    if (isCashSettlement) {
      // The timeout has to be re-asserted IN the claim, not just checked beforehand. Between
      // the read above and this update, a fresh push could move an expired attempt back to
      // live -- re-stamping terminal_pushed_at to now. Matching terminal_pending only when its
      // push time is still older than the cutoff (or absent) means such a row silently fails
      // to claim and surfaces as a conflict, rather than cash landing on a live card payment.
      const cashStatusList = settleableStatuses.join(',')
      claimQuery = claimQuery.or(
        `payment_status.in.(${cashStatusList}),` +
          `and(payment_status.eq.terminal_pending,` +
          `or(terminal_pushed_at.is.null,terminal_pushed_at.lt.${inFlightCutoffIso}))`,
      )
    } else {
      claimQuery = claimQuery.in('payment_status', [...settleableStatuses])
    }

    const { data: claimed, error: ordersError } = await claimQuery.select('id')

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

    // Gateway-issued merchant order numbers exist only for card. Guarded so a client that
    // sends one alongside a cash settlement cannot stamp a Finatic reference onto it.
    if (businessOrderNo && !isCashSettlement) {
      await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: businessOrderNo.slice(0, 32) })
        .in('id', claimedIds)
        .eq('restaurant_id', terminal.restaurantId)
        .is('paycloud_merchant_order_no', null)
    }

    await safeIssueReceiptsForOrders(claimedIds, 'terminal/tabs/settle')

    // Recalculate tab total from what is still owed. A failed read must not be read as
    // "nothing is owed" -- that would write tabs.total = 0 over genuine debt, so the previous
    // total is left standing and the caller is told the figure is stale.
    //
    // Partitioned in JS with owesMoney(), not with `.neq('payment_status', 'paid')` in SQL.
    // "not paid" is true of a CANCELLED order, so a cancelled order's money kept being
    // reported as owed -- issue #104, the same defect c362efc fixed in the tables view. SQL
    // equality is also byte-exact, so a stray 'Paid' would have counted too; owesMoney
    // normalises before comparing.
    const { data: tabOrderRows, error: unpaidError } = await supabase
      .from('orders')
      .select('total, payment_status')
      .eq('tab_id', tabId)

    let newTotal: number | null = null
    if (!unpaidError) {
      newTotal = (tabOrderRows ?? [])
        .filter((o) => owesMoney(o.payment_status))
        .reduce((sum, o) => sum + Number(o.total), 0)
      await supabase
        .from('tabs')
        .update({ total: newTotal })
        .eq('id', tabId)
    } else {
      console.error('[terminal/tabs/settle] tab total recalc failed', unpaidError)
    }

    // Create payment record (server amount, not client)
    await supabase.from('payments').insert({
      restaurant_id: terminal.restaurantId,
      table_id: tab.table_id,
      tab_id: tabId,
      order_ids: claimedIds,
      amount: expectedAmount,
      method,
      status: 'completed',
      gateway_reference: isCashSettlement ? null : gatewayReference,
      payment_reference: paymentReference,
      completed_at: paidAt,
    })

    // Audit log. Cash carries a real risk of being taken and not recorded, so the trail names
    // the staff member when one authorized it and says so explicitly when none did -- an
    // absent attribution must be visible as absent rather than inferred from a missing key.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: isCashSettlement ? 'payment.tab_settled_cash' : 'payment.tab_settled',
      entity_type: 'tabs',
      entity_id: tabId,
      metadata: {
        order_ids: claimedIds,
        amount: expectedAmount,
        client_amount: amount,
        method,
        payment_reference: paymentReference,
        terminal_id: terminal.terminalId,
        device_serial: terminal.deviceSerial,
        settled_at: paidAt,
        staff_user_id: attributedStaffUserId,
        actor_attribution: attributedStaffUserId ? 'staff_authorized' : 'terminal_only',
        authorization_token_id: authorizationTokenId || null,
        // Present only when cash was taken over a card attempt the timeout had declared dead.
        // How long those attempts had actually been hanging is the evidence for whether
        // CARD_IN_FLIGHT_TIMEOUT_SECONDS is set correctly -- it was chosen on reasoning, since
        // no historical card round-trip durations exist to measure against.
        ...(expiredInFlightSeconds.length > 0
          ? {
              card_in_flight_seconds: expiredInFlightSeconds,
              card_in_flight_timeout_seconds: CARD_IN_FLIGHT_TIMEOUT_SECONDS,
            }
          : {}),
      },
    })

    if (auditError) {
      console.error('[terminal/tabs/settle] audit log insert failed', auditError)
    }

    // canClose check. Fails CLOSED: an errored read previously yielded an empty array and so
    // reported the tab fully settled, letting staff close a table that still owed money.
    // Same owesMoney() partition as the recalc above, and for the same reason (#104): asked as
    // `!= 'paid'`, one cancelled order kept a table un-closeable from the terminal for good.
    const { data: remaining, error: remainingError } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('tab_id', tabId)

    if (remainingError) {
      console.error('[terminal/tabs/settle] can_close check failed', remainingError)
    }

    const canClose =
      !remainingError && (remaining ?? []).filter((o) => owesMoney(o.payment_status)).length === 0

    // Split statements + settled_at guard, both explained in full on the helper. This used to
    // be written out inline here, which is exactly how the single-order terminal payment route
    // was left holding the original fused, unguarded version (issue #123) -- so it lives in one
    // place now and every caller that takes tab money shares it.
    await clearReadyToPayAndReopenTab(supabase, {
      tabId,
      logPrefix: '[terminal/tabs/settle]',
      tabWasClosedOut: tab.settled_at != null,
    })

    return NextResponse.json({
      success: true,
      payment_reference: paymentReference,
      method,
      // null when the recalculation could not be trusted -- the stored total is unchanged.
      new_tab_total: newTotal,
      tab_total_stale: newTotal === null,
      can_close: canClose,
      staff_user_id: attributedStaffUserId,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
