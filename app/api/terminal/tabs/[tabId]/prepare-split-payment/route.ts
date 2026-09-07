/**
 * POST /api/terminal/tabs/{tabId}/prepare-split-payment — mint a reference for a part-order card
 * charge, and hold the items it covers.
 *
 * ============================================================================================
 * THE SIBLING OF prepare-payment, NOT A REPLACEMENT FOR IT
 * ============================================================================================
 *
 * `POST /api/terminal/orders/{id}/prepare-payment` mints (or returns)
 * orders.paycloud_merchant_order_no for a WHOLE-ORDER charge, and it is untouched: every venue's
 * ordinary card payment still goes through it, unchanged, and a defect here cannot reach it.
 * Owner's ruling, 2026-09-06.
 *
 * This route exists because that column is ONE VALUE PER ORDER, minted once and never rotated. A
 * second card charge against the same order would reuse the first charge's reference, and the
 * webhook — which correlates byte-exact — could not tell the two settlements apart. Three people
 * paying for their own items on one order is the ordinary case this makes possible.
 *
 * ============================================================================================
 * IT HOLDS THE ITEMS THE MOMENT IT MINTS
 * ============================================================================================
 *
 * The intent is created `launched`, and from that instant allocationIdsHeldByLiveCard reports
 * these allocations as held — so settle-allocations refuses cash (or a second card) for them
 * while this charge is live. The hold exists BEFORE the reader is touched, deliberately: the
 * window between "we decided to charge" and "the reader answered" is exactly when a second
 * payment for the same food would be taken.
 *
 * ============================================================================================
 * IT CHARGES NOTHING AND SETTLES NOTHING
 * ============================================================================================
 *
 * It mints a reference and returns it. The device drives the reader; POST .../record-split-payment
 * records the outcome. Nothing here writes to an order, an allocation, or a payment.
 */
import { NextResponse } from 'next/server'
import { parseTipCents } from '@/lib/payments/tips'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import {
  allocationIdsHeldByLiveCard,
  createPaymentIntent,
} from '@/lib/payments/payment-intents'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'

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
    /**
     * orders:update -- THE PERMISSION THE DEVICE ACTUALLY HOLDS.
     *
     * This gated on `payments:process` until 2026-09-09, and no terminal could call it. Terminal
     * tokens carry exactly `orders:read`, `orders:update`, `tables:read` (TERMINAL_JWT_PERMISSIONS
     * in lib/terminals/terminal-jwt.ts), spread literally into every token by signTerminalJwt with
     * no per-restaurant or per-role variation. `payments:process` is a USER-ROLE permission --
     * owner, manager, cashier -- and a terminal JWT is a DEVICE identity, so the gate was not
     * merely too tight, it was uncloseable.
     *
     * orders:update is what the WHOLE-ORDER card path uses (tabs/[tabId]/settle) and what the
     * cash-by-item path uses (tabs/[tabId]/settle-allocations). Charging part of an order is a
     * subset of charging all of it; gating the subset harder than the whole was the error.
     *
     * The invariant is now enforced: __tests__/terminal-route-permissions.test.ts fails if any
     * terminal route requires a permission the token cannot carry.
     */
    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json(
        { error: 'This terminal cannot take payments', code: 'MISSING_PERMISSION' },
        { status: 403 },
      )
    }

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json(
        { error: 'tabId must be a valid UUID', code: 'BAD_TAB_ID' },
        { status: 400 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as {
      allocation_ids?: unknown
      tip_cents?: unknown
      tipCents?: unknown
      tip_staff_user_id?: unknown
      tipStaffUserId?: unknown
    }
    const rawIds = Array.isArray(body.allocation_ids) ? body.allocation_ids : []
    const allocationIds = [...new Set(rawIds.map((id) => String(id).trim()))].filter(Boolean)

    if (allocationIds.length === 0) {
      return NextResponse.json(
        { error: 'allocation_ids must be a non-empty array', code: 'NO_ALLOCATIONS' },
        { status: 400 },
      )
    }
    if (allocationIds.some((id) => !isUuid(id))) {
      return NextResponse.json({ error: 'Invalid allocation_ids', code: 'INVALID_ALLOCATION_ID' }, { status: 400 })
    }

    /**
     * CREDENTIALS BEFORE ANYTHING IS MINTED, exactly as prepare-payment does since #160.
     *
     * At a venue with no Finatic merchant/store pair, minting first produces a reference nothing
     * can ever honour: the device launches the reader under it, and every later question about it
     * — the webhook, a portal search — lands in the same credential throw. Four such references
     * exist on production from before that fix. This route refuses first for the same reason, and
     * a refusal here has cost nothing because no hold has been placed yet either.
     */
    try {
      await getRestaurantFinaticCredentials(terminal.restaurantId)
    } catch (credentialsError) {
      if (isMissingFinaticCredentialsError(credentialsError)) {
        return NextResponse.json(
          {
            error: 'Card payments are not set up for this restaurant.',
            code: 'NO_FINATIC_CREDENTIALS',
          },
          { status: 409 },
        )
      }
      throw credentialsError
    }

    /**
     * THE ALLOCATIONS MUST BE REAL, THIS TAB'S, UNVOIDED AND UNSETTLED.
     *
     * Read rather than trusted: the amount charged is derived from these rows, so an id the caller
     * invented would otherwise become an amount the reader is asked for.
     */
    const { data: allocations, error: allocationsError } = await supabase
      .from('order_line_allocations')
      .select('id, amount_cents, settled_at, voided_at')
      .in('id', allocationIds)
      .eq('tab_id', tabId)
      .eq('restaurant_id', terminal.restaurantId)

    if (allocationsError) {
      console.error('[prepare-split-payment] allocation read failed', allocationsError)
      return NextResponse.json(
        { error: 'Could not read these items', code: 'ITEMS_READ_FAILED' },
        { status: 500 },
      )
    }

    const rows = allocations ?? []
    const found = new Set(rows.map((r) => String(r.id)))
    const missing = allocationIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      return NextResponse.json(
        { error: 'Some items are not on this tab', code: 'ALLOCATION_NOT_ON_TAB', allocation_ids: missing },
        { status: 400 },
      )
    }

    const unavailable = rows.filter((r) => r.settled_at != null || r.voided_at != null)
    if (unavailable.length > 0) {
      return NextResponse.json(
        {
          error: 'Some of those items have already been paid for or removed.',
          code: 'ALLOCATION_NOT_PAYABLE',
          allocation_ids: unavailable.map((r) => String(r.id)),
        },
        { status: 409 },
      )
    }

    /**
     * ALREADY HELD BY ANOTHER CARD? Refuse before minting a second reference for the same food.
     * Fails closed for the same reason settle-allocations does.
     */
    let held: string[] = []
    try {
      held = await allocationIdsHeldByLiveCard(supabase, {
        restaurantId: terminal.restaurantId,
        allocationIds,
      })
    } catch (holdError) {
      console.error('[prepare-split-payment] hold check failed', holdError)
      return NextResponse.json(
        { error: 'Could not confirm no card payment is in progress for these items', code: 'HOLD_CHECK_FAILED' },
        { status: 503 },
      )
    }
    if (held.length > 0) {
      return NextResponse.json(
        {
          error: 'A card payment is already in progress for some of these items.',
          code: 'ITEMS_HELD_BY_CARD',
          allocation_ids: held,
        },
        { status: 409 },
      )
    }

    /**
     * THE AMOUNT IS THE SERVER'S, derived from the allocations, never taken from the device.
     * `order_line_allocation_settlements.amount_cents` is always the allocation's own amount — v1
     * settles an allocation whole — so this is the figure the ledger will record too.
     */
    const itemsCents = rows.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0)

    /**
     * ================================================================================================
     * THE GRATUITY IS PART OF WHAT THE READER IS ASKED FOR
     * ================================================================================================
     *
     * `amount_cents` on this row is the single figure the customer is charged, and it is also what
     * checkSaleAmount reconciles a gateway echo against -- basis 'intent', NOT advisory, at
     * GATEWAY_AMOUNT_TOLERANCE_CENTS of zero. So the tip has to be inside it BEFORE the charge.
     *
     * WHAT HAPPENED WITHOUT THIS. Every processPaymentIntent call site passed bill-only amounts, so
     * the reader was asked for the bill and the tip was recorded afterwards as though collected --
     * an under-charge, silent, with the ledger disagreeing with the money. Adding the tip only at
     * settle time reproduces exactly that.
     *
     * ITEMS AND TIP ARE KEPT APART IN THE LEDGER. This sum is what the CARD is charged; the
     * allocations settle at their own amounts and the gratuity is written to payment_tips, which is
     * why the tip is carried separately below rather than folded into any allocation. A tip is not
     * revenue and must never enter an order total -- owner's ruling, 2026-09-05.
     */
    const tipParse = parseTipCents(body.tip_cents ?? body.tipCents)
    if (!tipParse.ok) {
      return NextResponse.json(
        { error: tipParse.message, code: tipParse.code },
        { status: 400 },
      )
    }
    const tipCents = tipParse.tipCents
    const tipStaffUserId = String(body.tip_staff_user_id ?? body.tipStaffUserId ?? '').trim()

    /**
     * A GRATUITY NEEDS A NAMED RECIPIENT, checked here rather than at settle time.
     *
     * The whole-order route refuses this at settle -- which on the split path would refuse AFTER the
     * card had been charged, leaving money taken and nothing recorded. Refusing before the reader
     * launches is the only safe place for it.
     */
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
    if (tipCents > 0) {
      const { data: tipMember, error: tipMemberError } = await supabase
        .from('restaurant_users')
        .select('user_id')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('user_id', tipStaffUserId)
        .maybeSingle()
      // FAILS CLOSED. An unverifiable recipient is not a verified one, and this runs before any
      // money moves, so refusing costs a retry rather than a reconciliation.
      if (tipMemberError || !tipMember) {
        return NextResponse.json(
          { error: 'That person does not work at this venue.', code: 'TIP_STAFF_NOT_A_MEMBER' },
          { status: 400 },
        )
      }
    }

    const amountCents = itemsCents + tipCents
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json(
        { error: 'Those items do not add up to a chargeable amount', code: 'NOT_CHARGEABLE' },
        { status: 400 },
      )
    }

    const intent = await createPaymentIntent(supabase, {
      restaurantId: terminal.restaurantId,
      terminalId: terminal.terminalId,
      tabId,
      amountCents,
      scope: 'allocations',
      tipCents,
      tipStaffUserId: tipCents > 0 ? tipStaffUserId : null,
      allocationIds,
    })

    return NextResponse.json({
      intent_id: intent.id,
      // The device sends this to WiseCashier as businessOrderNo, verbatim.
      merchant_order_no: intent.merchantOrderNo,
      amount_cents: intent.amountCents,
      allocation_ids: intent.allocationIds,
    })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[prepare-split-payment] failed', error)
    return NextResponse.json(
      { error: 'Failed to prepare the payment', code: 'PREPARE_FAILED' },
      { status: 500 },
    )
  }
}
