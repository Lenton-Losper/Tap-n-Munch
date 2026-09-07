import { NextResponse } from 'next/server'
import { parseTipCents } from '@/lib/payments/tips'
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

    /**
     * ================================================================================================
     * RECORD WHAT THE READER IS ABOUT TO BE ASKED FOR
     * ================================================================================================
     *
     * THE INVARIANT: the amount sent to the gateway must be the amount verification compares
     * against. The split path already holds to it through an intent's amount_cents; this is the
     * whole-order equivalent, and it must be written BEFORE the reader launches, because after the
     * charge there is no way to know a gratuity was included.
     *
     * WITHOUT IT, verify-payment, the webhook and the reconcile cron each recomputed order.total --
     * so a tipped charge was refused by all three AFTER the customer's card had been debited. Which
     * is why the tip was never added to the charge, and was instead recorded as collected while the
     * customer paid the bill alone.
     *
     * THE TIP IS OPTIONAL AND ABSENT MEANS NONE. An older terminal sends no body at all, records an
     * expectation equal to the order total, and behaves exactly as before.
     */
    const body = (await req.json().catch(() => ({}))) as {
      tip_cents?: unknown
      tipCents?: unknown
      tip_staff_user_id?: unknown
      tipStaffUserId?: unknown
      order_ids?: unknown
      orderIds?: unknown
    }

    /**
     * EVERY ORDER IN THIS SETTLEMENT, not just the one in the URL.
     *
     * A tab settle charges the SUM of the selected orders, but this route is order-shaped and
     * computed the expected charge from the URL order ALONE. With one order those agree; with two
     * they do not, and the device charged the FIRST order's total plus the tip instead of the
     * tab's. Reported from a P5 as "the gratuity sometimes does not reach the cashier" -- the
     * gratuity was fine, the BILL was short.
     *
     * Absent means just this order, so an older terminal is unchanged.
     */
    const rawOrderIds = Array.isArray(body.order_ids)
      ? body.order_ids
      : Array.isArray(body.orderIds)
        ? body.orderIds
        : []
    const settlementOrderIds = [
      ...new Set([orderId, ...rawOrderIds.map((id) => String(id).trim()).filter(Boolean)]),
    ]
    const tipParse = parseTipCents(body.tip_cents ?? body.tipCents)
    if (!tipParse.ok) {
      return NextResponse.json({ error: tipParse.message, code: tipParse.code }, { status: 400 })
    }
    const tipCents = tipParse.tipCents
    const tipStaffUserId = String(body.tip_staff_user_id ?? body.tipStaffUserId ?? '').trim()

    /**
     * A GRATUITY NEEDS A NAMED RECIPIENT, REFUSED BEFORE THE CHARGE.
     *
     * payment_tips.staff_user_id is NOT NULL and orders_pending_tip_needs_staff enforces the same
     * thing. Refusing at settle time -- which is where the whole-order route checks it today --
     * would refuse AFTER the card had been charged, leaving money taken and no gratuity recorded.
     */
    if (tipCents > 0 && !tipStaffUserId) {
      return NextResponse.json(
        {
          error:
            'Choose who is taking this gratuity before charging. A tip has to be recorded ' +
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
      // FAILS CLOSED, and it costs only a retry: nothing has been charged yet.
      if (tipMemberError || !tipMember) {
        return NextResponse.json(
          { error: 'That person does not work at this venue.', code: 'TIP_STAFF_NOT_A_MEMBER' },
          { status: 400 },
        )
      }
    }

    try {
      const { merchantOrderNo, created } = await ensureTerminalMerchantOrderNo(supabase, {
        orderId,
        restaurantId: terminal.restaurantId,
      })

      /**
       * The order total is the SERVER's, re-read here rather than taken from the device -- the
       * device's figure is what we are about to check, so it cannot also be the thing we check it
       * against.
       */
      const { data: orderRows, error: orderReadError } = await supabase
        .from('orders')
        .select('id, total')
        .in('id', settlementOrderIds)
        .eq('restaurant_id', terminal.restaurantId)

      // Every named order must be readable. A partial read would understate the charge, which is
      // the failure this whole change exists to remove.
      const orderRow =
        orderRows && orderRows.length === settlementOrderIds.length ? orderRows : null

      if (orderReadError || !orderRow) {
        // FAILS CLOSED. Launching a reader without recording what it was asked for is exactly the
        // state this whole change exists to remove.
        return NextResponse.json(
          { error: 'Could not read the order total', code: 'ORDER_TOTAL_UNREADABLE' },
          { status: 503 },
        )
      }

      const centsFor = (row: { total?: unknown }) => Math.round((Number(row.total) || 0) * 100)
      const orderCents = orderRow.reduce((sum, r) => sum + centsFor(r), 0)
      const chargeCents = orderCents + tipCents

      /**
       * THE EXPECTATION IS WRITTEN PER ORDER, and it has to be.
       *
       * expectedChargeForOrders SUMS each order's own pending_charge_cents. Writing the whole
       * charge onto one order would make the webhook expect that figure PLUS the other orders'
       * totals -- more than was charged -- and refuse a payment that succeeded.
       *
       * So each order carries its OWN total, and the gratuity rides on the one this request names.
       * The sum is then exactly what the reader was asked for.
       */
      let expectationError: { message: string } | null = null
      for (const row of orderRow) {
        const isTipCarrier = String(row.id) === orderId
        const { error } = await supabase
          .from('orders')
          .update({
            pending_charge_cents: centsFor(row) + (isTipCarrier ? tipCents : 0),
            pending_tip_cents: isTipCarrier ? tipCents : 0,
            pending_tip_staff_user_id: isTipCarrier && tipCents > 0 ? tipStaffUserId : null,
          })
          .eq('id', String(row.id))
          .eq('restaurant_id', terminal.restaurantId)
        if (error) {
          expectationError = error
          break
        }
      }

      if (expectationError) {
        /**
         * REFUSE RATHER THAN CHARGE. If the expectation cannot be stored, every downstream gate
         * will compare the gateway's echo against the ORDER TOTAL -- so a tipped charge would be
         * refused after the customer had paid it. Better to refuse now, having charged nothing.
         */
        console.error('[terminal/prepare-payment] could not record the charge expectation', {
          orderId,
          error: expectationError.message,
        })
        return NextResponse.json(
          {
            error: 'Could not prepare this payment. Try again.',
            code: 'EXPECTATION_NOT_RECORDED',
          },
          { status: 503 },
        )
      }

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
        /**
         * THE DEVICE CHARGES THIS, not its own arithmetic. Returning the figure the server just
         * recorded is what closes the loop: if the two were computed independently they could
         * disagree, and the gate would refuse a payment the customer had made.
         */
        chargeCents,
        tipCents,
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
