import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { ensureTerminalMerchantOrderNo } from '@/lib/payments/terminal-merchant-order'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
/**
 * Imported from finatic-credentials-error, NOT from finatic-restaurant-credentials, even though
 * the latter re-exports it. Eighteen suites replace finatic-restaurant-credentials with a factory
 * mock that returns only `getRestaurantFinaticCredentials`; a predicate imported from there would
 * read as `undefined` inside them and this catch would throw a TypeError instead of classifying.
 * That module's own header explains it at length — this is the second site to depend on it.
 */
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  PREPARE_PAYMENT_OUTCOME_CODES,
  PREPARE_PAYMENT_STAFF_MESSAGE,
  PREPARE_REFUSED_NO_CREDENTIALS_ACTION,
} from '@/lib/payments/prepare-payment-outcome'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Allocates (or returns) the backend-owned Finatic merchant_order_no for a terminal POS
 * SALE and persists it on orders.paycloud_merchant_order_no BEFORE the device launches
 * WiseCashier. The terminal must pass this exact value as businessOrderNo so
 * POST /api/webhooks/paycloud can correlate via paycloud_merchant_order_no.
 *
 * Idempotent for an unpaid order: repeats return the same persisted value.
 * Does not mark the order paid and does not issue receipts (Phase 1 scope).
 *
 * #160 — CREDENTIALS ARE ESTABLISHED BEFORE ANYTHING IS MINTED, AND THE ORDER OF THOSE TWO STEPS
 * IS THE WHOLE FIX.
 *
 * This route used to gate only on terminal auth and `orders:update`, then allocate. At a venue
 * with no Finatic merchant/store pair that produced a reference nothing could ever honour: the
 * device launched WiseCashier under it, and every later question about it — verify-payment, the
 * stale-POS sweep, a portal search — landed in the same credential throw. Four such references
 * exist on production (measured 2026-08-27, all at Digi Cofee: #18, #19, #28, #29) and two of
 * them were minted on the evening of 2026-08-26.
 *
 * REFUSING COSTS ONE SALE THAT COULD NOT HAVE SETTLED ANYWAY. Allocating costs an order that is
 * permanently unresolvable and, in the worst case, a charge on a reader whose merchant this system
 * does not record and cannot search. The issue's own conclusion, and the direction the sibling
 * sites already take: app/api/orders/route.ts:668 and payments/push-to-terminal/route.ts:163 both
 * load credentials before committing to anything, and terminal verify-payment does the same since
 * #153. prepare-payment was the site that did not.
 *
 * THE THIRD STATE IS NOT DECORATION. A credential read that FAILS is not a venue with no
 * credentials — it is an absent answer, and answering it with "card payment is not set up here"
 * would tell a venue that takes cards every day that it has never been configured. It refuses too,
 * because minting on the strength of a read that failed is the same mistake, but it refuses with a
 * different code and a different instruction. See lib/payments/prepare-payment-outcome.ts.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json(
        {
          error: 'orderId must be a valid UUID',
          outcome: PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED,
          staffMessage:
            PREPARE_PAYMENT_STAFF_MESSAGE[PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED],
        },
        { status: 400 },
      )
    }

    // ------------------------------------------------------------------------------------------
    // #160 GATE. Nothing below this block may run until it has passed, and nothing inside it
    // writes. `ensureTerminalMerchantOrderNo` is the only thing in this route that mints, and it
    // is deliberately the LAST thing that happens.
    // ------------------------------------------------------------------------------------------
    try {
      await getRestaurantFinaticCredentials(terminal.restaurantId)
    } catch (credErr: unknown) {
      const missing = isMissingFinaticCredentialsError(credErr)
      const outcome = missing
        ? PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE
        : PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN

      console.error('[terminal/prepare-payment] refused before allocating', {
        orderId,
        restaurantId: terminal.restaurantId,
        terminalId: terminal.terminalId,
        outcome,
        reason: credErr instanceof Error ? credErr.message : String(credErr),
      })

      if (missing) {
        /**
         * A console.error in a Worker lands where nobody reads it (Rule 21). The refusal is the
         * only server-side evidence that a venue is being asked for a card it cannot take, and
         * counting those is how anyone will know whether this is one misconfigured venue or a
         * fleet-wide onboarding gap.
         *
         * BEST EFFORT, ALWAYS. The refusal has already been decided by the time this runs;
         * a failed audit write must not be able to turn a correct refusal into a 500 — and must
         * certainly not fall through to allocating.
         */
        try {
          await supabase.from('audit_logs').insert({
            restaurant_id: terminal.restaurantId,
            entity_type: 'order',
            entity_id: orderId,
            action: PREPARE_REFUSED_NO_CREDENTIALS_ACTION,
            metadata: {
              terminalId: terminal.terminalId,
              outcome,
              // Stated explicitly because the opposite reading is the dangerous one: a refusal
              // here means no reference was minted and no card was presented, so this order is
              // NOT in the unverifiable state #160 is about.
              note:
                'prepare-payment refused before allocating a merchant order number: this venue ' +
                'has no Finatic merchant/store pair, so no card can settle here. No reference ' +
                'was minted and no card was presented.',
              refusedAt: new Date().toISOString(),
            },
          })
        } catch (auditErr) {
          console.error('[terminal/prepare-payment] refusal audit insert failed', auditErr)
        }
      }

      return NextResponse.json(
        {
          error: PREPARE_PAYMENT_STAFF_MESSAGE[outcome],
          outcome,
          staffMessage: PREPARE_PAYMENT_STAFF_MESSAGE[outcome],
          // Nothing was allocated. Said in the response because a terminal build that retries on
          // a missing merchantOrderNo must be able to tell "not yet" from "never".
          merchantOrderNo: null,
          allocated: false,
        },
        {
          // 400 for the permanent, venue-level fault and 502 for the transient one, matching the
          // split #153 settled on verify-payment: a configuration fault on our side is not a Bad
          // Gateway, and a failed read is not a configuration fault.
          status: missing ? 400 : 502,
        },
      )
    }

    try {
      const { merchantOrderNo, created } = await ensureTerminalMerchantOrderNo(supabase, {
        orderId,
        restaurantId: terminal.restaurantId,
      })

      console.log('[terminal/prepare-payment]', {
        orderId,
        restaurantId: terminal.restaurantId,
        terminalId: terminal.terminalId,
        merchantOrderNo,
        created,
      })

      return NextResponse.json({
        orderId,
        merchantOrderNo,
        created,
        outcome: null,
        staffMessage: null,
      })
    } catch (err: unknown) {
      const status =
        typeof err === 'object' && err && 'status' in err
          ? Number((err as { status: number }).status)
          : 500
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code: string }).code)
          : undefined
      const message = err instanceof Error ? err.message : 'Failed to prepare payment'

      /**
       * `code` keeps its existing values (ALREADY_PAID, ORDER_CANCELLED) untouched — four other
       * routes speak those strings and a fielded build reads them. `outcome` is additive.
       */
      const failed = PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED
      const staffMessage = PREPARE_PAYMENT_STAFF_MESSAGE[failed]

      if (status === 404) {
        return NextResponse.json(
          { error: message, outcome: failed, staffMessage },
          { status: 404 },
        )
      }
      if (status === 400) {
        return NextResponse.json(
          { error: message, code, outcome: failed, staffMessage },
          { status: 400 },
        )
      }
      console.error('[terminal/prepare-payment]', err)
      return NextResponse.json(
        { error: message, outcome: failed, staffMessage },
        { status: 500 },
      )
    }
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/prepare-payment]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
