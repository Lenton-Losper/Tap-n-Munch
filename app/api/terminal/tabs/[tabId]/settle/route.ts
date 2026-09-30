import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { generatePaymentReference } from '@/lib/payment-reference'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import { parseTipCents, recordTip } from '@/lib/payments/tips'
import { recordGatewaySaleEvent } from '@/lib/payments/record-gateway-sale-event'
import { recordNonGatewayPaymentEvent } from '@/lib/payments/record-non-gateway-payment-event'
import { consumeSettledOrdersIntent } from '@/lib/payments/consume-settled-orders-intent'
import {
  centsToMajor,
  FINANCIAL_ORDER_COLUMNS,
  loadTabFinancials,
  projectOrderRows,
  type FinancialOrderInput,
  type OrderFinancials,
  type TabFinancials,
} from '@/lib/orders/order-financials'
import {
  amountsMatch,
  methodUsesGateway,
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  isCardPaymentStillInFlight,
  secondsSincePush,
  normalizeSettlementPaymentMethod,
  roundToCents,
  settleableStatusesForMethod,
} from '@/lib/payments/payment-integrity'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { clearReadyToPayAndReopenTab } from '@/lib/tabs/settle-tab-state'
import {
  blocksSettlement,
  fetchPendingOrderRequests,
  summarisePendingForTab,
} from '@/lib/tabs/pending-order-requests'

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

    /**
     * THE GRATUITY RIDES ALONGSIDE `amount`, NOT INSIDE IT.
     *
     * `amount` is checked against the sum of the order totals below (AMOUNT_MISMATCH), and that
     * check is a money control -- it is what stops a terminal settling a tab for the wrong figure.
     * Folding a tip into `amount` would mean loosening it to "totals, or totals plus something",
     * which is not a check at all. So the bill and the gratuity are separate fields and the
     * existing comparison is untouched.
     *
     * The customer is charged the sum of the two in one transaction; the receipt prints both and
     * then the amount actually charged. Integer cents, never a currency float -- see
     * lib/payments/tips.ts for why a tip is cents and why it is not consideration for the supply.
     */
    const tipParse = parseTipCents(body.tip_cents ?? body.tipCents)
    if (!tipParse.ok) {
      return NextResponse.json({ error: tipParse.message, code: tipParse.code }, { status: 400 })
    }
    const tipCents = tipParse.tipCents

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
    /**
     * WHETHER A GATEWAY WAS INVOLVED AT ALL -- a different question from "is it cash".
     *
     * Until PayToday there were two methods, so `!isCashSettlement` meant "card" and the code said
     * so in seven places. With a third method that reading is false: PayToday settles OUTSIDE the
     * gateway, like cash, and taking the card branch would hand it a gateway reference for a
     * transaction no gateway has ever heard of.
     */
    const usesGateway = methodUsesGateway(method)

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
      // The financial columns feed the projection below (what is still owed per order).
      // The payment columns the claim below overwrites are read too, so a claim that has to be
      // undone (a partial claim -- see SETTLE_CLAIM_CONFLICT) can be put back exactly as it was.
      .select(
        `${FINANCIAL_ORDER_COLUMNS}, terminal_pushed_at, payment_method, payment_reference, payment_voucher_no, paid_at, completed_at, pending_charge_cents`,
      )
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

    /**
     * ================================================================================================
     * WHAT IS STILL OWED, NOT WHAT THE ORDERS ONCE COST
     * ================================================================================================
     *
     * Summing `orders.total` was correct only while settlement was order-grained. Once items can be
     * paid for individually, an order can be part-collected and its total is no longer what is
     * chargeable: order #45 was N$37.00 with N$17.00 already settled, and this would have taken the
     * same N$17.00 again -- on the cash path as readily as the card one.
     *
     * AND NOT WHAT WAS VOIDED. amend_order_lines never rewrites an order: a voided line stays in
     * `orders.total`, and a reduction's surviving quantity lives on a replacement order. Summing
     * `total` refused the terminal's correct line-based figure for every amended tab. Each order's
     * figure is now its OUTSTANDING amount from the one financial projection
     * (lib/orders/order-financials.ts): live (original minus voided lines) less the item ledger.
     *
     * FAILS CLOSED, deliberately. Not being able to read what has already been collected -- or
     * what was voided -- is not permission to collect it.
     */
    let financials: Map<string, OrderFinancials>
    try {
      financials = await projectOrderRows(
        supabase,
        (tabOrders ?? []) as unknown as FinancialOrderInput[],
      )
    } catch (e) {
      console.error('[terminal/tabs/settle] could not read settled cents', {
        error: e instanceof Error ? e.message : String(e),
      })
      return NextResponse.json(
        { error: 'Could not read what has already been paid', code: 'SETTLED_TOTAL_UNREADABLE' },
        { status: 503 },
      )
    }

    // Rounded because this figure is STORED, not only compared: it becomes payments.amount and
    // audit_logs.metadata.amount below, both `numeric` with no scale. The comparison on the
    // next line is unaffected either way -- amountsMatch works in integer cents (#180).
    const outstandingCentsOf = (id: unknown) => financials.get(String(id))?.outstandingCents ?? 0
    // The same figure in integer cents, for the ledgers: what the BILL is, gratuity excluded.
    const expectedCents = (tabOrders ?? []).reduce((sum, o) => sum + outstandingCentsOf(o.id), 0)
    const expectedAmount = roundToCents(centsToMajor(expectedCents))

    /**
     * A settlement that would collect nothing is refused rather than recorded. Every item is
     * already paid for, so there is no money to take and a `payments` row for zero would assert
     * a collection that never happened.
     */
    if (expectedAmount <= 0) {
      return NextResponse.json(
        { error: 'Those orders have already been paid for.', code: 'NOTHING_LEFT_TO_CHARGE' },
        { status: 409 },
      )
    }
    /**
     * ================================================================================================
     * A DEVICE THAT PREDATES THE OUTSTANDING BASIS IS NOT A DEVICE THAT DISAGREES
     * ================================================================================================
     *
     * The client leg is a CROSS-CHECK -- it catches a terminal whose idea of the money differs from
     * the server's. It is not the source of the figure; expectedAmount above is.
     *
     * APK 136 and earlier compute their amount the way selectClaimableOrdersForSettle does, by
     * summing order.total. That was the only basis in existence when they were built. Against the
     * outstanding basis they now differ by exactly the already-settled cents on a part-paid order,
     * and the check would refuse them.
     *
     * REFUSING IS THE DANGEROUS DIRECTION HERE. On the card path the reader has ALREADY been
     * charged the correct outstanding amount by the time this runs, so a refusal leaves a real
     * charge with no settlement recorded against it -- precisely the orphan this area exists to
     * prevent. On the cash path it blocks a legitimate collection outright.
     *
     * So the legacy basis is accepted TOO, and only the legacy basis: an exact second expectation,
     * both figures computed here from the server's own rows. No tolerance is widened -- amountsMatch
     * runs at its existing precision against each -- and an amount matching neither is still
     * refused.
     *
     * WHAT IS RECORDED IS ALWAYS expectedAmount. A device sending the legacy figure does not cause
     * the legacy figure to be written: payments.amount and the audit row stay the outstanding truth.
     *
     * DELETE THIS once every terminal in the field sends the outstanding basis. It is dead weight
     * from the moment the oldest deployed APK computes it, and the warning below is how you will
     * know that day has come -- it stops being logged.
     */
    const legacyWholeOrderAmount = roundToCents(
      (tabOrders ?? []).reduce((sum, o) => sum + Number(o.total), 0),
    )
    const matchesLegacyBasis =
      legacyWholeOrderAmount !== expectedAmount && amountsMatch(amount, legacyWholeOrderAmount)

    if (matchesLegacyBasis) {
      console.warn('[terminal/tabs/settle] client sent the pre-outstanding basis', {
        tabId,
        received: amount,
        expected: expectedAmount,
        legacy: legacyWholeOrderAmount,
        recording: expectedAmount,
      })
    }

    if (!matchesLegacyBasis && !amountsMatch(amount, expectedAmount)) {
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

    /**
     * WHO IS TAKING THE GRATUITY — AN UNVERIFIED CLAIM, AND DELIBERATELY A SEPARATE FIELD.
     *
     * ============================================================================================
     * WHY NOT `attributedStaffUserId`
     * ============================================================================================
     *
     * That value is VERIFIED: it exists only because a PIN was typed and a single-use
     * authorization token was consumed against purpose 'cash_settlement'. It is what the audit
     * trail means by `actor_attribution: 'staff_authorized'`.
     *
     * `tip_staff_user_id` is NOT that. It comes from a picker on the terminal with no PIN behind
     * it: ANYONE HOLDING THE TERMINAL CAN PICK ANYONE. Merging the two would silently downgrade
     * every existing `staff_user_id` in the audit trail from "proved" to "asserted" -- an
     * invisible change to the one field that answers "who took the cash".
     *
     * So: a distinct wire field, a distinct variable, and a distinct audit key.
     *
     * ============================================================================================
     * WHY UNVERIFIED IS THE RIGHT TRADE HERE, AND WHERE IT WOULD NOT BE
     * ============================================================================================
     *
     * A PIN for gratuities was built and then ruled out, 2026-09-05: friction on every
     * transaction. And MEASURED ON PRODUCTION, all 23 settlements to date carry NO staff_user_id
     * at all -- so a PIN gate would not have added friction to tips, it would have blocked 100%
     * of them.
     *
     * A mis-tap here misattributes a gratuity: a payroll correction. The same looseness would be
     * unacceptable for a REFUND, a CASH SETTLEMENT or a WALKOUT CLOSE, each of which writes away
     * money or debt. Those keep the PIN, and THIS PATTERN MUST NOT BE REUSED FOR THEM.
     * A picker is attribution. A PIN is authorisation. They are not interchangeable.
     *
     * MANDATORY WHEN A TIP IS KEYED -- the only version with no gap, since a gratuity recorded as
     * nobody's is what payment_tips.staff_user_id NOT NULL exists to prevent. Refused BEFORE the
     * claim, so nothing is half-done. A settle with NO tip is unaffected.
     */
    const tipStaffUserId = String(body.tip_staff_user_id ?? body.tipStaffUserId ?? '').trim()
    /**
     * NO PAYTODAY GRATUITY IN v1. Owner's ruling, 2026-09-09.
     *
     * Enforced here AND in the schema: payment_tips.method is still CHECK (method IN ('cash','card')),
     * so a PayToday tip would fail at the database. Refusing at the boundary makes it a clean 400
     * rather than a constraint violation surfacing as a 500 -- and refusing BEFORE the orders are
     * claimed means a rejected tip cannot leave a settled tab behind it.
     *
     * A waiter taking a gratuity through PayToday takes it in Nedbank's app, where FlashTap cannot
     * see it and has nothing to attribute.
     */
    if (tipCents > 0 && method === 'paytoday') {
      return NextResponse.json(
        {
          error: 'Gratuities are not supported on PayToday. Take the tip separately.',
          code: 'PAYTODAY_NO_TIPS',
          tip_cents: tipCents,
        },
        { status: 400 },
      )
    }
    if (tipCents > 0 && !tipStaffUserId) {
      return NextResponse.json(
        {
          error:
            'Choose who is taking this gratuity before settling. A tip has to be recorded ' +
            'against a member of staff.',
          code: 'TIP_NEEDS_STAFF',
          tip_cents: tipCents,
        },
        { status: 400 },
      )
    }

    /**
     * IT MUST AT LEAST BE SOMEBODY WHO WORKS HERE.
     *
     * Unverified does not mean unchecked. `payment_tips.staff_user_id` is an FK to users(id),
     * which would happily accept a real user from ANOTHER venue, so without this a terminal could
     * attribute a gratuity to a stranger. Same membership the picker itself lists.
     */
    if (tipCents > 0) {
      const { data: tipMember, error: tipMemberError } = await supabase
        .from('restaurant_users')
        .select('user_id')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('user_id', tipStaffUserId)
        .is('deleted_at', null)
        .maybeSingle()

      if (tipMemberError || !tipMember) {
        return NextResponse.json(
          {
            error: 'That staff member is not on this venue, so the gratuity cannot be recorded.',
            code: 'TIP_STAFF_NOT_A_MEMBER',
          },
          { status: 400 },
        )
      }
    }

    const paidAt = new Date().toISOString()
    const paymentReference = generatePaymentReference()
    // Cash never carries a gateway artifact. Letting a stale voucher/gateway reference ride
    // along would print a card-style reference on a cash receipt.
    // A voucher number is a READER artefact. Cash and PayToday have none, and inventing one
    // would put a card-shaped reference on a payment no card was used for.
    const paymentVoucherNo = usesGateway ? voucherNo || gatewayReference || null : null

    /**
     * A NON-GATEWAY SETTLEMENT IS A FRESH CHARGE AT THE LIVE AMOUNT (team-lead ruling,
     * 20260929140000). It must neither race a card attempt that may be running nor settle over a
     * dead one. When any selected order carries a prepared card charge, release_stale_card_attempts
     * decides, under the orders' row locks: inside the in-flight window (or an intent whose answer
     * is unknown) -> 409 PAYMENT_IN_FLIGHT and nothing is written; older -> the attempt is released
     * (charge cleared, launched intent expired, audited) before the claim below.
     *
     * Asked only when there is something to release, so every settlement with no card history is
     * exactly as before. FAILS CLOSED: an error is a refusal, never a settlement over an attempt.
     */
    if (!usesGateway && (tabOrders ?? []).some((o) => (o as { pending_charge_cents?: unknown }).pending_charge_cents != null)) {
      const { data: release, error: releaseError } = await supabase.rpc('release_stale_card_attempts', {
        p_restaurant_id: terminal.restaurantId,
        p_order_ids: orderIds,
        p_source: 'terminal/tabs/settle',
        p_actor_user_id: attributedStaffUserId,
      })
      if (releaseError) {
        console.error('[terminal/tabs/settle] could not check for a card attempt in flight', releaseError)
        return NextResponse.json(
          { error: 'Could not check for a card payment in progress. Try again.', code: 'CARD_ATTEMPT_UNREADABLE' },
          { status: 503 },
        )
      }
      const released = (release ?? {}) as { ok?: boolean; in_flight_order_ids?: string[] }
      if (released.ok !== true) {
        return NextResponse.json(
          {
            error:
              'A card payment for part of this selection may still be in progress. Wait for it to ' +
              'finish or cancel it on the terminal, then take the payment.',
            code: 'PAYMENT_IN_FLIGHT',
            order_ids: released.in_flight_order_ids ?? [],
          },
          { status: 409 },
        )
      }
      // The released orders no longer carry the charge; the claim below must restore THAT state
      // if it ever has to be undone, not the dead attempt.
      for (const o of tabOrders ?? []) {
        ;(o as Record<string, unknown>).pending_charge_cents = null
      }
    }

    // The rows as READ, copied before the claim, so a partial claim can be undone exactly.
    const priorById = new Map(
      (tabOrders ?? []).map((o) => [String(o.id), { ...(o as Record<string, unknown>) }]),
    )

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

    /**
     * THE CARD WAS CHARGED FOR AN ORDER THAT HAS SINCE CHANGED (team-lead ruling, Sprint 2026-09-29).
     *
     * orders_refuse_paid_on_changed_charge (20260929120000) raises FTCHG when a card payment would
     * mark paid an order whose items, voids or item settlements moved after the charge was prepared.
     * The claim is one statement, so NOTHING was claimed -- and the reader has already taken the
     * money. Answering 500 would invite a retry and leave the charge recorded nowhere. Instead every
     * order in the charged selection is HELD for review (amount_mismatch_hold, what
     * markOrderPaidConfirmed does for the same refusal), so none of them can be charged again, and the
     * charge is written down for staff to reconcile.
     */
    if (ordersError && String((ordersError as { code?: unknown }).code ?? '') === 'FTCHG') {
      const { data: heldRows, error: holdError } = await supabase
        .from('orders')
        .update({ payment_status: 'amount_mismatch_hold' })
        .in('id', orderIds)
        .eq('tab_id', tabId)
        .eq('restaurant_id', terminal.restaurantId)
        .in('payment_status', [...settleableStatuses])
        .select('id')
      if (holdError) {
        console.error('[terminal/tabs/settle] could not hold orders changed during payment', holdError)
      }
      const heldIds = (heldRows ?? []).map((r) => String(r.id))
      const { error: heldAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'payment.held_order_changed_since_charge_prepared',
        entity_type: 'tabs',
        entity_id: tabId,
        metadata: {
          source: 'terminal/tabs/settle',
          reason: 'order_changed_since_preparation',
          requested_order_ids: orderIds,
          held_order_ids: heldIds,
          card_charged: true,
          amount: expectedAmount,
          client_amount: Number.isFinite(amount) ? amount : null,
          tip_cents: tipCents,
          business_order_no: businessOrderNo || null,
          voucher_no: voucherNo || null,
          gateway_reference: gatewayReference || null,
          terminal_id: terminal.terminalId,
          note:
            'The card was charged, but an order in this selection changed after the charge was ' +
            'prepared. Nothing was marked paid; the orders are held for review. Check what the ' +
            'customer owes against what was charged and refund or collect the difference.',
          recorded_at: new Date().toISOString(),
        },
      })
      if (heldAuditError) {
        console.error('[terminal/tabs/settle] held-order audit failed', heldAuditError)
      }
      return NextResponse.json(
        {
          error:
            'The card was charged, but an order changed while it was being paid. The orders are ' +
            'held for review; nothing was marked paid.',
          code: 'ORDER_CHANGED_DURING_PAYMENT',
          card_charged: true,
          held_order_ids: heldIds,
        },
        { status: 409 },
      )
    }

    if (ordersError) {
      return NextResponse.json(
        { error: 'Failed to update orders' },
        { status: 500 }
      )
    }

    const claimedIds = (claimed ?? []).map((o) => String(o.id))
    if (claimedIds.length !== orderIds.length) {
      /**
       * ALL OR NOTHING (Sprint 2026-09-28 brief, N2).
       *
       * The claim is one UPDATE, but it matches row by row: an order another payment took between
       * the validation above and this statement simply does not match, and the rest DO. This used
       * to answer 409 and stop -- leaving the claimed orders paid with no payments row, no ledger
       * row, no receipt, no audit and no tab total recompute, which is a partial settlement with no
       * trail. On the card path the reader has already charged the customer by now.
       *
       * So the orders this request claimed are put back exactly as they were read, conditioned on
       * THIS request's own payment_reference (generated above, unique) so nothing another writer
       * did since is touched. A 409 now leaves nothing paid by this request -- and the conflict,
       * including whether a card was charged, is written down for staff to refund or reconcile.
       */
      const revertedIds: string[] = []
      const revertFailedIds: string[] = []
      for (const id of claimedIds) {
        const prior = priorById.get(id) as Record<string, unknown> | undefined
        const { data: reverted, error: revertError } = await supabase
          .from('orders')
          .update({
            payment_status: prior?.payment_status ?? null,
            payment_method: prior?.payment_method ?? null,
            payment_reference: prior?.payment_reference ?? null,
            payment_voucher_no: prior?.payment_voucher_no ?? null,
            status: prior?.status ?? null,
            paid_at: prior?.paid_at ?? null,
            completed_at: prior?.completed_at ?? null,
            terminal_pushed_at: prior?.terminal_pushed_at ?? null,
            // The settled-charge trigger stamped this on the way INTO paid; undo that too.
            settled_charge_cents: prior?.settled_charge_cents ?? null,
          })
          .eq('id', id)
          .eq('restaurant_id', terminal.restaurantId)
          .eq('payment_reference', paymentReference)
          .select('id')
        if (revertError || !reverted || reverted.length === 0) {
          revertFailedIds.push(id)
          console.error('[terminal/tabs/settle] could not undo a partial claim', {
            order_id: id,
            payment_reference: paymentReference,
            error: revertError,
          })
        } else {
          revertedIds.push(id)
        }
      }
      const claimedSet = new Set(claimedIds)
      const lostToAnotherPayment = orderIds.filter((id) => !claimedSet.has(id))

      const { error: conflictAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'payment.settle_claim_conflict',
        entity_type: 'tabs',
        entity_id: tabId,
        metadata: {
          requested_order_ids: orderIds,
          claimed_then_reverted_order_ids: revertedIds,
          // Non-empty means orders are left PAID by this request with nothing else recorded.
          revert_failed_order_ids: revertFailedIds,
          lost_to_another_payment_order_ids: lostToAnotherPayment,
          method,
          // THE FLAG STAFF NEED. On the card path the reader charged the customer before this
          // request arrived; nothing in this system now records that money except this row.
          card_charged: usesGateway,
          amount: expectedAmount,
          client_amount: Number.isFinite(amount) ? amount : null,
          tip_cents: tipCents,
          business_order_no: businessOrderNo || null,
          voucher_no: voucherNo || null,
          gateway_reference: gatewayReference || null,
          payment_reference: paymentReference,
          terminal_id: terminal.terminalId,
          device_serial: terminal.deviceSerial,
          staff_user_id: attributedStaffUserId,
          note: usesGateway
            ? 'A card was charged for these orders, but another payment took some of them first. ' +
              'Nothing was settled by this charge. Check the gateway and refund or reconcile it.'
            : 'Another payment took some of these orders first. Nothing was settled; no money ' +
              'is recorded against this attempt.',
          recorded_at: new Date().toISOString(),
        },
      })
      if (conflictAuditError) {
        console.error('[terminal/tabs/settle] claim conflict audit insert failed', conflictAuditError)
      }

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
          // Unchanged meaning for existing builds: what this request's claim matched. Every one of
          // them has since been put back unless it is also in revert_failed_order_ids.
          claimed_order_ids: claimedIds,
          reverted_order_ids: revertedIds,
          revert_failed_order_ids: revertFailedIds,
          card_charged: usesGateway,
        },
        { status: 409 },
      )
    }

    /**
     * ================================================================================================
     * THE NON-GATEWAY LEDGER ROW -- NO LEDGER, NO SETTLEMENT (Sprint 2026-09-29 brief)
     * ================================================================================================
     *
     * EVERY SUCCESSFUL PAYMENT MUST HAVE AN IMMUTABLE FINANCIAL LEDGER RECORD. The F2 ruling below
     * ("THAT LEAVES CASH WITH NO LEDGER ROW") is reversed for that half: cash and PayToday now get a
     * `non_gateway_payment_events` row. The other half of F2 stands -- the row is NOT in
     * payment_events, so nothing that reconciles against Finatic can mistake it for a gateway sale.
     *
     * REQUIRED, and written right after the claim so a failure can still be undone. Nothing has moved
     * through a gateway on this path: the cash is in the waiter's hand, and a refused settlement is
     * one they retry. So when the row cannot be written the claim is put back exactly as it was read
     * (conditioned on this request's own reference, like the N2 undo above) and the request fails --
     * a paid order with no ledger row is exactly what the invariant forbids. The ledger row itself is
     * immutable and so is never the thing undone: it is written LAST of the things that can fail.
     *
     * Amount = the server's bill (Σ outstanding) + the gratuity, the same "what was collected"
     * meaning payment_events.amount has for a card; tip_cents says which part was the gratuity.
     */
    let nonGatewayLedgerEventId: string | null = null
    if (!usesGateway) {
      const ledger = await recordNonGatewayPaymentEvent(supabase, {
        restaurantId: terminal.restaurantId,
        origin: 'terminal_tab_settle',
        method,
        billCents: expectedCents,
        tipCents,
        orderIds: claimedIds,
        tabId,
        paymentReference,
        idempotencyKey: `terminal_tab_settle:${paymentReference}`,
        recordedBy: attributedStaffUserId,
        actorAttribution: attributedStaffUserId ? 'staff_authorized' : 'terminal_only',
        terminalId: terminal.terminalId,
        source: 'terminal/tabs/settle',
      })
      if (!ledger.recorded) {
        const unrevertedIds: string[] = []
        for (const id of claimedIds) {
          const prior = priorById.get(id) as Record<string, unknown> | undefined
          const { data: undone, error: undoError } = await supabase
            .from('orders')
            .update({
              payment_status: prior?.payment_status ?? null,
              payment_method: prior?.payment_method ?? null,
              payment_reference: prior?.payment_reference ?? null,
              payment_voucher_no: prior?.payment_voucher_no ?? null,
              status: prior?.status ?? null,
              paid_at: prior?.paid_at ?? null,
              completed_at: prior?.completed_at ?? null,
              terminal_pushed_at: prior?.terminal_pushed_at ?? null,
              settled_charge_cents: prior?.settled_charge_cents ?? null,
            })
            .eq('id', id)
            .eq('restaurant_id', terminal.restaurantId)
            .eq('payment_reference', paymentReference)
            .select('id')
          if (undoError || !undone || undone.length === 0) unrevertedIds.push(id)
        }
        console.error('[terminal/tabs/settle] non-gateway ledger row NOT written; settlement undone', {
          tabId,
          order_ids: claimedIds,
          payment_reference: paymentReference,
          unreverted_order_ids: unrevertedIds,
          error: ledger.error,
        })
        const { error: ledgerAuditError } = await supabase.from('audit_logs').insert({
          restaurant_id: terminal.restaurantId,
          action: 'payment.settle_ledger_not_recorded',
          entity_type: 'tabs',
          entity_id: tabId,
          metadata: {
            order_ids: claimedIds,
            // Non-empty means orders are left PAID with no ledger row. Staff must reconcile.
            unreverted_order_ids: unrevertedIds,
            method,
            amount: expectedAmount,
            tip_cents: tipCents,
            payment_reference: paymentReference,
            terminal_id: terminal.terminalId,
            staff_user_id: attributedStaffUserId,
            error: ledger.error ?? null,
            recorded_at: new Date().toISOString(),
          },
        })
        if (ledgerAuditError) {
          console.error('[terminal/tabs/settle] ledger-failure audit insert failed', ledgerAuditError)
        }
        return NextResponse.json(
          {
            error: 'The payment could not be recorded, so nothing was settled. Try again.',
            code: 'PAYMENT_LEDGER_NOT_RECORDED',
            unreverted_order_ids: unrevertedIds,
          },
          { status: 503 },
        )
      }
      nonGatewayLedgerEventId = ledger.eventId
    }

    /**
     * WHAT THIS SETTLEMENT APPLIED TO EACH ORDER (orders.settled_charge_cents, 20260928135000).
     *
     * The projection reads `paid` for a paid order from this column. On the gateway paths a trigger
     * captures it from pending_charge_cents; this route states it EXPLICITLY, per order, because a
     * cash settlement can land on an order still carrying a dead card attempt's expectation, and a
     * fully voided order settled here at zero has no attempt at all. An explicit value survives the
     * trigger.
     *
     * After the claim, not inside it: PostgREST cannot write a different value per row in one
     * statement, and splitting the claim would give up its atomicity. A failed write is logged and
     * reported -- the money is taken and the orders are paid either way; what is lost is only the
     * precision of the paid figure (the order then reads on the legacy basis, paid = total).
     */
    let settledChargeRecorded = true
    for (const id of claimedIds) {
      const { error: settledChargeError } = await supabase
        .from('orders')
        .update({ settled_charge_cents: outstandingCentsOf(id) })
        .eq('id', id)
        .eq('restaurant_id', terminal.restaurantId)
      if (settledChargeError) {
        settledChargeRecorded = false
        console.error('[terminal/tabs/settle] settled charge not recorded', {
          order_id: id,
          settled_charge_cents: outstandingCentsOf(id),
          error: settledChargeError,
        })
      }
    }

    // Gateway-issued merchant order numbers exist only for card. Guarded so a client that
    // sends one alongside a cash settlement cannot stamp a Finatic reference onto it.
    //
    // Every write from here down runs AFTER the claim, so the money is taken and the orders are
    // already paid. None of them may abort the request: a throw lands in the catch at the bottom
    // of this route, which answers 401 Unauthorized -- telling staff a settlement that succeeded
    // was an auth failure, and inviting a retry against orders that are already claimed. So they
    // are logged and surfaced instead, the same contract lib/tabs/settle-tab-state.ts states for
    // its own post-payment writes. What is NOT acceptable is what these three did before (#195):
    // discard the result entirely, leaving no trace anywhere that the write did not land.
    if (businessOrderNo && !isCashSettlement) {
      const { error: stampError } = await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: businessOrderNo.slice(0, 32) })
        .in('id', claimedIds)
        .eq('restaurant_id', terminal.restaurantId)
        .is('paycloud_merchant_order_no', null)

      if (stampError) {
        // Reconciliation against Finatic is by this reference, so losing it costs traceability
        // of a real charge -- not the charge itself.
        console.error('[terminal/tabs/settle] merchant order number stamp failed', {
          order_ids: claimedIds,
          business_order_no: businessOrderNo.slice(0, 32),
          error: stampError,
        })
      }
    }

    await safeIssueReceiptsForOrders(claimedIds, 'terminal/tabs/settle')

    // Recalculate tab total from what is still owed. A failed read must not be read as
    // "nothing is owed" -- that would write tabs.total = 0 over genuine debt, so the previous
    // total is left standing and the caller is told the figure is stale.

    /**
     * ONE PROJECTION FOR BOTH THE STORED TOTAL AND can_close BELOW.
     *
     * Still owed = Σ outstanding over the tab (lib/orders/order-financials.ts): a paid or cancelled
     * order owes nothing (#104's owesMoney rule lives inside the projection), a voided line owes
     * nothing, a reduction's surviving quantity is owed once -- on its replacement -- and the item
     * ledger's collections are subtracted. A failed read leaves the stored total as it was and
     * reports it stale (#195), and blocks can_close.
     */
    let tabFinancials: TabFinancials | null = null
    try {
      tabFinancials = await loadTabFinancials(supabase, terminal.restaurantId, tabId)
    } catch (e) {
      console.error('[terminal/tabs/settle] tab total recalc failed', {
        tabId,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    let newTotal: number | null = null
    if (tabFinancials) {
      // Integer cents to major units at the write, the one rounding point (#191): tabs.total is
      // `numeric` with no scale and is served on as the balance owed.
      const recalculated = roundToCents(centsToMajor(tabFinancials.outstandingCents))
      const { error: totalWriteError } = await supabase
        .from('tabs')
        .update({ total: recalculated })
        .eq('id', tabId)

      // A failed WRITE leaves the stored total exactly as stale as a failed read does, so it
      // gets the same answer: the figure is withheld rather than reported as the tab's balance.
      // Returning it would have the terminal show a number the database does not hold.
      if (totalWriteError) {
        console.error('[terminal/tabs/settle] tab total write failed', {
          tabId,
          attempted_total: recalculated,
          error: totalWriteError,
        })
      } else {
        newTotal = recalculated
      }
    }

    /**
     * ================================================================================================
     * F10 — WHAT THE `payments` TABLE ACTUALLY IS, MEASURED
     * ================================================================================================
     *
     * The comment below used to call this "the money record itself". It is not, and saying so was
     * the most misleading sentence in this route. Measured on production, read-only, 2026-09-19:
     *
     *   payments            14 rows, 2026-06-26 .. 2026-09-07
     *   paid orders       5,389
     *   cash paid orders    551
     *
     * So it records 0.26% of settlements. It is not the payment ledger, it is not the cash ledger,
     * and it is not a competing source of truth -- because nothing competes: THIS IS ITS ONLY
     * WRITER IN THE APPLICATION, AND THERE ARE NO READERS. `git grep "from('payments')"` returns
     * this line and three test-fixture deletes.
     *
     * ================================================================================================
     * IT IS STILL REQUIRED, FOR EXACTLY ONE THING
     * ================================================================================================
     *
     * `payment_tips.payment_id` is a foreign key to `payments(id)`, and the gratuity recorded below
     * needs a settlement row to point at. Stop writing this and `tipOutcome` becomes
     * `not_recorded_no_payment_row` for every tip taken on the whole-order path -- a real
     * regression in the one area where money is easiest to lose.
     *
     * (The FK is presently unexercised: all 6 tips on production carry `payment_id = NULL`, because
     * every one of them was taken through the ALLOCATION path, which passes no payment id. That
     * makes the dependency latent rather than absent, which is a reason to keep it, not to drop it.)
     *
     * SO: NOT DEPRECATED, NOT DELETED, NOT EXPANDED. It stays as the anchor row a gratuity hangs
     * off, and nothing is given it to do beyond that. The authoritative ledger is
     * `payment_events`, written by recordGatewaySaleEvent below and by settle_order_payment().
     *
     * If it fails the orders are paid, the tab is settled and receipts are out, with no row saying
     * the restaurant was paid -- so the failure is recorded in three places that outlive the
     * request: the log, the audit trail below, and the response.
     *
     * `.select('id')` because the gratuity is recorded against this row -- payment_tips.payment_id
     * names the settlement the tip rode on, and without the id there is nothing to point at.
     */
    const { data: paymentRow, error: paymentInsertError } = await supabase
      .from('payments')
      .insert({
        restaurant_id: terminal.restaurantId,
        table_id: tab.table_id,
        tab_id: tabId,
        order_ids: claimedIds,
        amount: expectedAmount,
        method,
        status: 'completed',
        // NULL for anything settled outside the gateway. See usesGateway.
        gateway_reference: usesGateway ? gatewayReference : null,
        payment_reference: paymentReference,
        completed_at: paidAt,
      })
      .select('id')
      .maybeSingle()

    if (paymentInsertError) {
      console.error('[terminal/tabs/settle] payment record insert failed', {
        tabId,
        order_ids: claimedIds,
        amount: expectedAmount,
        method,
        payment_reference: paymentReference,
        error: paymentInsertError,
      })
    }

    /**
     * ================================================================================================
     * THE LEDGER ROW, WRITTEN HERE RATHER THAN HOPED FOR (F2)
     * ================================================================================================
     *
     * Until now the only writer of a `payment_events` sale row for this settlement was the DEVICE,
     * afterwards, and it does not wait for the answer. Terminal 9426f990,
     * `src/screens/TableDetailScreen.tsx`:
     *
     *     if (businessOrderNo && transactionId) {
     *       recordSaleEvent({...}, token).then(r => { if (!r.ok) console.warn(...) })
     *     } else {
     *       console.warn('[TableDetail] Skipping recordSaleEvent - missing businessOrderNo or voucherNo')
     *     }
     *
     * Not awaited, never retried, and skipped outright when either value is absent. Measured on
     * production 2026-09-19: 1,630 paid card orders worth N$110,027 have no sale row.
     *
     * THE SAME TABLE AND THE SAME KEY THE DEVICE USES, so this is one ledger and not two -- when the
     * device's call does arrive it takes the existing 23505 branch in the sale route, finds this
     * row, and returns it.
     *
     * GATEWAY METHODS ONLY. `payment_events` is keyed on a gateway reference and is what a Finatic
     * reconciliation joins against; cash and PayToday have no such transaction, and a sale row for
     * them would be one that can never be matched to anything -- worse than an absence, because it
     * looks reconciled.
     *
     * CASH AND PAYTODAY: CLOSED (Sprint 2026-09-29 brief). This used to read "THAT LEAVES CASH WITH NO
     * LEDGER ROW ... a gap this sprint names rather than closes". They now get their row in
     * `non_gateway_payment_events`, written and required right after the claim (above).
     *
     * THE AMOUNT IS WHAT THE CARD WAS CHARGED: the bill PLUS the gratuity (Sprint 2026-09-29 brief,
     * task 3). It used to be `expectedAmount`, the bill alone, while settle_order_payment() records
     * `p_gateway_amount_cents` -- the charge, tip included -- for the same kind of row. So a tipped
     * tab settle wrote a sale row that disagreed with the charge, the device's own recordSaleEvent
     * (which reports the charged amount) then hit this row's key with a different amount and got a
     * 409, and the refundable balance derived from it was short by the tip. The gratuity part stays
     * derivable exactly as for the RPC's rows: payment_tips.tip_cents under this payment_reference.
     *
     * NOT AWAITED FOR ITS SUCCESS -- the settlement has already happened. The outcome is carried
     * into the audit metadata and the response, the same contract `payment_record_written` has.
     */
    let saleEventOutcome: string | null = null
    if (usesGateway) {
      const sale = await recordGatewaySaleEvent(supabase, {
        restaurantId: terminal.restaurantId,
        orderIds: claimedIds,
        // The gateway's own reference. Absent means there is nothing to key a ledger row on, and
        // inventing one would produce a row that matches no Finatic transaction (see F17).
        businessOrderNo: businessOrderNo || null,
        transactionId: voucherNo || gatewayReference || null,
        // THE SERVER'S FIGURE -- the bill it validated plus the gratuity it recorded. `amount` is
        // the client's and is only ever a cross-check.
        amount: roundToCents(centsToMajor(expectedCents + tipCents)),
        terminalId: terminal.terminalId,
        source: 'terminal/tabs/settle',
      })
      saleEventOutcome = sale.outcome
      // Sprint 2026-09-30: the charge's orders-scope intent is resolved by this settlement, as
      // settle_order_payment does on the gateway paths. See consume-settled-orders-intent.ts.
      await consumeSettledOrdersIntent(supabase, {
        restaurantId: terminal.restaurantId,
        merchantOrderNo: businessOrderNo || null,
        settledOrderIds: claimedIds,
        chargedCents: expectedCents + tipCents,
        transactionId: voucherNo || gatewayReference || null,
        paymentMethod: method,
        source: 'terminal/tabs/settle',
      })
      if (sale.outcome === 'failed' || sale.outcome === 'skipped_no_reference') {
        console.error('[terminal/tabs/settle] payment ledger row NOT written', {
          tabId,
          order_ids: claimedIds,
          business_order_no: businessOrderNo || null,
          outcome: sale.outcome,
          error: sale.error,
        })
      }
    }

    /**
     * THE GRATUITY, recorded against the payment that carried it.
     *
     * AFTER the money, never before: the customer has been charged, and `recordTip` is built not
     * to throw for exactly this reason -- a gratuity that fails to record must not turn a
     * completed settlement into a 500 with the table still occupied.
     *
     * IF THE PAYMENT ROW DID NOT LAND, NEITHER CAN THE TIP. payment_tips requires a settlement to
     * point at, and inventing one would be worse than the gap. The outcome is carried into the
     * audit metadata and the response, the same way payment_record_written already is, so a
     * gratuity that was taken and not recorded is VISIBLE rather than inferred from silence.
     */
    const paymentId = paymentRow?.id ? String(paymentRow.id) : null
    let tipOutcome: string | null = null
    if (tipCents > 0) {
      if (!paymentId) {
        tipOutcome = 'not_recorded_no_payment_row'
        console.error('[terminal/tabs/settle] gratuity could not be recorded: no payments row', {
          tabId,
          tip_cents: tipCents,
          // The PICKER value — this log is about the lost gratuity, so it must name who the tip
          // was for, not who authorised the settlement. Left as attributedStaffUserId until a
          // mutation harness refused an ambiguous anchor and surfaced it.
          tip_staff_user_id: tipStaffUserId,
        })
      } else {
        const tip = await recordTip(supabase, {
          restaurantId: terminal.restaurantId,
          tipCents,
          // The gratuity is taken by the same instrument as the bill it rode on.
          /**
           * The gratuity is taken by the same instrument as the bill it rode on -- the METHOD, not
           * a guess derived from whether it was cash. Narrowed because PayToday cannot reach here:
           * a PayToday tip is refused above, before anything is claimed.
           */
          method: method as Exclude<typeof method, 'paytoday'>,
          // Non-null by the TIP_NEEDS_ATTRIBUTION gate above, which refuses before the claim.
          // The PICKER value, not attributedStaffUserId. See the trust note above.
          staffUserId: tipStaffUserId,
          tabId,
          paymentReference,
          paymentId,
        })
        tipOutcome = tip.recorded ? 'recorded' : tip.reason
        if (!tip.recorded && tip.reason === 'failed') {
          console.error('[terminal/tabs/settle] gratuity insert failed', {
            tabId,
            tip_cents: tipCents,
            error: tip.error,
          })
        }
      }
    }

    // Audit log. Cash carries a real risk of being taken and not recorded, so the trail names
    // the staff member when one authorized it and says so explicitly when none did -- an
    // absent attribution must be visible as absent rather than inferred from a missing key.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      /**
       * ONE ACTION PER METHOD, so a trail can be read by method without parsing metadata. PayToday
       * gets its own rather than being folded into either existing one: it is neither a gateway
       * settlement nor money in a drawer, and a reconciliation against Nedbank's statement needs to
       * find it by name.
       */
      action:
        method === 'cash'
          ? 'payment.tab_settled_cash'
          : method === 'paytoday'
            ? 'payment.tab_settled_paytoday'
            : 'payment.tab_settled',
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
        // Whether a payments row exists for this settlement. The audit trail is the only durable
        // record when it does not, so it must say so rather than imply a payment row by silence.
        payment_record_written: !paymentInsertError,
        // F2. Whether the authoritative LEDGER row exists for this settlement. Recorded rather
        // than inferred: a card sale with no payment_events row is precisely the silent gap that
        // left 1,630 paid orders unreconcilable against Finatic.
        ...(usesGateway ? { sale_event: saleEventOutcome } : {}),
        // Sprint 2026-09-29: the immutable ledger row of a cash / PayToday settlement.
        ...(!usesGateway ? { ledger_event_id: nonGatewayLedgerEventId } : {}),
        /**
         * The gratuity, if one was keyed. Present ONLY when there was one, so an absent key means
         * "no tip" and never "a tip we lost". `tip_recorded` carries the outcome verbatim --
         * recorded | duplicate | failed | not_recorded_no_payment_row -- because a gratuity taken
         * from a customer and not written down is exactly the thing that must not be silent.
         */
        ...(tipCents > 0
          ? {
              tip_cents: tipCents,
              tip_recorded: tipOutcome,
              tip_method: method as Exclude<typeof method, 'paytoday'>,
              // Named apart from staff_user_id on purpose: that one is PIN-proved, this is a
              // picker claim with nothing behind it. Do not collapse them.
              tip_staff_user_id: tipStaffUserId,
              tip_attribution: 'picker_unverified',
            }
          : {}),
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

    // canClose check. Fails CLOSED: a projection that could not be read blocks it (it used to
    // yield an empty array and report the tab fully settled). Asked of what is still OWED, not of
    // payment_status: a pending order whose every line was voided owes nothing and must not keep
    // the table open, and a cancelled order owes nothing either (#104).

    /**
     * #120. `remaining` above reads `orders`, and a round staff have not Accepted yet is not in
     * `orders` at all — so this check has always been blind to it. Settling every order on the tab
     * therefore reported `can_close: true` while a round placed minutes earlier was still waiting
     * for review; accepting it afterwards re-inflates a tab that has been paid and closed.
     *
     * Asked by tab AND by table for the reason given on fetchPendingOrderRequests: `tab_id` is
     * nullable on that table.
     */
    const pendingRequests = await fetchPendingOrderRequests(supabase, {
      restaurantId: terminal.restaurantId,
      tabIds: [tabId],
      tableIds: [tab.table_id],
    })
    const pendingForTab = summarisePendingForTab(pendingRequests, tabId, tab.table_id)

    const canClose =
      tabFinancials !== null &&
      tabFinancials.outstandingCents === 0 &&
      !blocksSettlement(pendingForTab)

    // Split statements + settled_at guard, both explained in full on the helper. This used to
    // be written out inline here, which is exactly how the single-order terminal payment route
    // was left holding the original fused, unguarded version (issue #123) -- so it lives in one
    // place now and every caller that takes tab money shares it.
    await clearReadyToPayAndReopenTab(supabase, {
      tabId,
      logPrefix: '[terminal/tabs/settle]',
      tabWasClosedOut: tab.settled_at != null,
      // #287. THE subset-settlement path: staff can settle a selection of orders, so this is
      // exactly where one diner paying used to wipe the signal for everyone still waiting.
      reason: 'money_taken',
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
      // false means the money moved and the orders are paid but no payments row was created.
      // The settlement still succeeded, so this is not an error status -- it is a reconciliation
      // flag, and the only thing at the call site that can tell the difference.
      payment_record_written: !paymentInsertError,
      // Additive. false = the per-order settled charge was not written for at least one order; the
      // settlement stands, and those orders read on the legacy basis (paid = total).
      settled_charge_recorded: settledChargeRecorded,
      /**
       * F2. 'recorded' | 'already_recorded' | 'skipped_no_reference' | 'failed'. Either of the
       * first two means the ledger row exists; anything else means this card sale has none and
       * needs reconciling. Absent for cash and PayToday, which have no gateway transaction a
       * ledger row could ever be matched to.
       *
       * ADDITIVE for a fielded build: the terminal still calls recordSaleEvent afterwards and
       * still gets a 200 back, because that call now finds this row through its existing
       * idempotency branch instead of inserting one.
       */
      ...(usesGateway ? { sale_event: saleEventOutcome } : {}),
      // Additive. The non_gateway_payment_events row that records a cash / PayToday settlement.
      ...(!usesGateway ? { ledger_event_id: nonGatewayLedgerEventId } : {}),
      // Same contract as payment_record_written: absent means no gratuity was keyed, and a value
      // other than 'recorded' means one was taken and needs reconciling. The terminal can print
      // the receipt either way -- the settlement succeeded.
      ...(tipCents > 0 ? { tip_cents: tipCents, tip_recorded: tipOutcome } : {}),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tabs/settle]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
