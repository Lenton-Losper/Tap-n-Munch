/**
 * POST /api/terminal/tabs/{tabId}/record-split-payment — what the reader said about a part-order
 * card charge.
 *
 * ============================================================================================
 * THREE OUTCOMES, AND ONLY TWO OF THEM ARE ANSWERS
 * ============================================================================================
 *
 *   success    the charge is proven. The intent is confirmed and its allocations are settled.
 *   failed     the gateway said no. The intent is failed and its allocations are RELEASED, free
 *              for anyone to pay.
 *   uncertain  WE DO NOT KNOW. The intent stays holding: not settled, not released.
 *
 * The device's own vocabulary is richer (`ambiguous`, `orphaned_ambiguous`, timeouts) but every one
 * of those collapses to `uncertain` here, because they mean the same thing to this route: the
 * gateway may still answer yes.
 *
 * ============================================================================================
 * WHY UNCERTAIN HOLDS RATHER THAN RELEASES
 * ============================================================================================
 *
 * E04111 from this gateway means NO RECORD, never NOT PAID. If an uncertain charge released its
 * items, a second customer could pay for the first customer's food while the first customer's card
 * was still settling — and a tab stays open for exactly that long. Held means: not paid, not
 * available, and visibly pending to the waiter.
 *
 * NOTHING IN THIS CODEBASE MOVES AN UNCERTAIN INTENT ON ITS OWN. No sweeper, no timeout, no cron.
 * A webhook resolves it (app/api/webhooks/paycloud) or a human does. Auto-settling turns E04111
 * into a free meal; auto-failing takes a real charge twice. Owner's ruling, 2026-09-06.
 *
 * ============================================================================================
 * IT DOES NOT SETTLE ANYTHING ITSELF
 * ============================================================================================
 *
 * On success it calls the same settle-allocations logic every other settlement uses, passing its
 * own intent id so the hold it placed does not block it. There is deliberately no second way to
 * mark an allocation paid: one writer, one ledger.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import {
  findIntentByMerchantOrderNo,
  markIntentConfirmed,
  markIntentFailed,
  markIntentUncertain,
  type PaymentIntent,
} from '@/lib/payments/payment-intents'
import { settleAllocationsForIntent } from '@/lib/payments/settle-allocations-for-intent'

export const dynamic = 'force-dynamic'

/** What the device may report. Anything unrecognised is treated as uncertain, never as failure. */
const OUTCOMES = new Set(['success', 'failed', 'uncertain'])

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

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
      /**
       * ITS OWN CODE, not prepare's BAD_TAB_ID, and the difference is the whole point.
       *
       * On prepare, a bad tab id means nothing has happened yet -- the reader never ran, and
       * the waiter can safely go back and start again. On RECORD, the reader has ALREADY run:
       * the customer may be holding a receipt. The same fault therefore needs the opposite
       * instruction, so it gets a code that maps to the may-have-been-charged wording rather
       * than to 'pick the items fresh'.
       */
      return NextResponse.json(
        { error: 'tabId must be a valid UUID', code: 'RECORD_BAD_TAB_ID' },
        { status: 400 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as {
      merchant_order_no?: unknown
      outcome?: unknown
      transaction_id?: unknown
      gateway_result_code?: unknown
    }

    const merchantOrderNo = String(body.merchant_order_no ?? '').trim()
    if (!merchantOrderNo) {
      return NextResponse.json(
        { error: 'merchant_order_no is required', code: 'NO_REFERENCE' },
        { status: 400 },
      )
    }

    /**
     * ANYTHING UNRECOGNISED IS UNCERTAIN, NOT FAILED.
     *
     * A build this server has not met, a truncated body, a new device outcome — none of those is
     * evidence the customer was not charged, and treating them as failure would release the items
     * and invite a second payment. The safe default on a money path is "we do not know".
     */
    const rawOutcome = String(body.outcome ?? '').trim().toLowerCase()
    const outcome = OUTCOMES.has(rawOutcome) ? rawOutcome : 'uncertain'

    let intent: PaymentIntent | null = null
    try {
      intent = await findIntentByMerchantOrderNo(supabase, merchantOrderNo)
    } catch (lookupError) {
      // FAILS CLOSED. Not being able to read the intent is not permission to decide its fate.
      console.error('[record-split-payment] intent lookup failed', lookupError)
      return NextResponse.json(
        { error: 'Could not read this payment', code: 'INTENT_LOOKUP_FAILED' },
        { status: 503 },
      )
    }

    if (!intent) {
      return NextResponse.json({ error: 'Unknown payment reference', code: 'NO_INTENT' }, { status: 404 })
    }
    if (intent.restaurantId !== terminal.restaurantId) {
      // Same answer as absent, deliberately: another venue's reference is not this terminal's
      // business and its existence is not something to confirm.
      return NextResponse.json({ error: 'Unknown payment reference', code: 'NO_INTENT' }, { status: 404 })
    }
    if (intent.scope !== 'allocations') {
      return NextResponse.json(
        { error: 'That reference is not a split payment', code: 'WRONG_SCOPE' },
        { status: 400 },
      )
    }

    /**
     * ALREADY RESOLVED? Say so and change nothing.
     *
     * The device retries, and a webhook may have confirmed this while the device was deciding it
     * was uncertain. A confirmed intent must never be walked back — see markIntent* — so this is
     * reported rather than re-applied.
     */
    if (intent.status === 'confirmed' || intent.status === 'failed') {
      return NextResponse.json({
        intent_id: intent.id,
        status: intent.status,
        already_resolved: true,
      })
    }

    if (outcome === 'uncertain') {
      await markIntentUncertain(supabase, intent.id)
      return NextResponse.json({
        intent_id: intent.id,
        status: 'uncertain',
        // Said explicitly so the device does not render this as a failure.
        items_held: intent.allocationIds,
      })
    }

    if (outcome === 'failed') {
      await markIntentFailed(supabase, intent.id)
      return NextResponse.json({
        intent_id: intent.id,
        status: 'failed',
        items_released: intent.allocationIds,
      })
    }

    // success
    const settled = await settleAllocationsForIntent(supabase, {
      intent,
      paymentReference: merchantOrderNo,
      transactionId: String(body.transaction_id ?? '').trim() || null,
      source: 'terminal/record-split-payment',
    })

    if (!settled.ok) {
      /**
       * THE CHARGE IS REAL AND THE LEDGER WRITE FAILED. The intent stays UNRESOLVED — not failed —
       * so the items stay held and the webhook can still settle them. Reporting failure here would
       * release food the customer has already paid for.
       */
      console.error('[record-split-payment] settlement failed after a proven charge', {
        intentId: intent.id,
        merchantOrderNo,
        reason: settled.reason,
      })
      return NextResponse.json(
        {
          error: 'The card was charged but the items could not be marked paid. Do not charge again.',
          code: 'SETTLEMENT_FAILED_AFTER_CHARGE',
          intent_id: intent.id,
        },
        { status: 500 },
      )
    }

    await markIntentConfirmed(supabase, intent.id)

    return NextResponse.json({
      intent_id: intent.id,
      status: 'confirmed',
      settled_allocation_ids: settled.settledAllocationIds,
      orders_closed: settled.ordersClosed,
    })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[record-split-payment] failed', error)
    return NextResponse.json(
      { error: 'Failed to record this payment', code: 'RECORD_FAILED' },
      { status: 500 },
    )
  }
}
