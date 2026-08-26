import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { newHeldPaymentReceiptId } from '@/lib/payments/held-payment-receipt-id'

export const dynamic = 'force-dynamic'

/**
 * #344 RULING 3 — POST /api/terminal/held-payments
 *
 * Stores a card payment the terminal recovered but could not apply. THE DURABLE WRITE IS THE
 * ACKNOWLEDGEMENT: on a 2xx carrying `stored: true`, the device deletes its only copy of the
 * transaction. Everything in here is shaped by that one sentence.
 *
 * ============================================================================================
 * THE CONTRACT, ALL FOUR ANSWERS
 * ============================================================================================
 *
 *   1. A durable write is the acknowledgement. This route never waits on reconciliation and never
 *      calls Finatic. It writes a row and answers.
 *   2. The idempotency key is businessOrderNo + heldAt, computed by the device and opaque here.
 *   3. An already-stored record is an acknowledgement. This route returns 200 with the SAME
 *      receiptId rather than 409 -- both release the device, and the same id is strictly more
 *      useful to the operator who pressed the button twice. The device accepts either.
 *   4. The response is `stored` and `receiptId`, NOTHING ELSE.
 *
 * ON (4), AND WHY IT IS ENFORCED HERE RATHER THAN TRUSTED. The owner ruled out `matchedOrderId`
 * and every other reconciliation field in as many words: "a field the device must ignore is a
 * field someone will eventually read." This route knows things it must not say -- whether the
 * business_order_no matches a known order, whether the row is new -- and the response object is
 * built literally, from two values, so adding one is a deliberate edit rather than a spread.
 *
 * ============================================================================================
 * IT NEVER REFUSES A RECORD OVER THE SHAPE OF THE EVIDENCE
 * ============================================================================================
 *
 * A non-2xx means the device keeps holding. That is correct when the write did not happen, and it
 * is a disaster when the write COULD have happened but a validation rule declined it: the operator
 * then has no way to clear a record that will never be accepted, and the transaction stays on one
 * Android device until that device is wiped.
 *
 * So `orphanOrderId`, `reason`, `outcomeKind` and the rest are stored as sent, unvalidated. The
 * only 400s are for the two fields without which the row cannot be addressed at all
 * (`idempotencyKey`, `heldAt`), and both are computed by the device rather than entered by a human.
 *
 * ============================================================================================
 * GATED ON orders:update, NOT ON A NEW PERMISSION
 * ============================================================================================
 *
 * Terminal tokens carry exactly `orders:read`, `orders:update`, `tables:read`
 * (lib/terminals/terminal-jwt.ts). Introducing a `payments:hold` would mean every device in the
 * field is refused until its token refreshes -- and the refusal would be a 403, which the device
 * correctly treats as "not stored", so the whole estate would silently stop being able to
 * acknowledge for as long as the rollout took. Reusing the permission the device already holds
 * costs nothing here: this endpoint writes an evidence row for the terminal's own restaurant and
 * can neither settle an order nor move money.
 *
 * NO audit_logs ROW. The held_payments row IS the record; a second one keyed to an order id that
 * may not resolve would add a trail entry nobody can follow back to anything.
 */
export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))

    const idempotencyKey = String(body?.idempotencyKey ?? '').trim()
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: 'idempotencyKey is required' },
        { status: 400 },
      )
    }

    const heldAtRaw = String(body?.heldAt ?? '').trim()
    const heldAt = heldAtRaw ? new Date(heldAtRaw) : null
    if (!heldAt || Number.isNaN(heldAt.getTime())) {
      return NextResponse.json(
        { error: 'heldAt is required and must be an ISO timestamp' },
        { status: 400 },
      )
    }

    /** Everything else is evidence, and evidence is stored as sent. */
    const text = (v: unknown): string | null => {
      const s = v === null || v === undefined ? '' : String(v).trim()
      return s.length > 0 ? s : null
    }

    /*
     * READ FIRST. The common re-POST is a device retrying after a response it never received, so
     * the ordinary path is a hit here and no write at all. The insert below still has to handle
     * the unique violation, because two devices -- or one device twice -- can race between this
     * read and that insert.
     */
    const { data: existing, error: readError } = await supabase
      .from('held_payments')
      .select('receipt_id')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()

    if (readError) {
      console.error('[terminal/held-payments] lookup failed', readError)
      return NextResponse.json({ error: 'Failed to store held payment' }, { status: 500 })
    }

    if (existing?.receipt_id) {
      // Ruling 3. Already stored IS acknowledged, and the receiptId is the one issued the first
      // time -- the operator who pressed twice sees one reference, not two.
      return NextResponse.json({ stored: true, receiptId: String(existing.receipt_id) })
    }

    const receiptId = newHeldPaymentReceiptId()

    const { error: insertError } = await supabase.from('held_payments').insert({
      restaurant_id: terminal.restaurantId,
      terminal_id: terminal.terminalId,
      idempotency_key: idempotencyKey,
      business_order_no: text(body?.businessOrderNo),
      held_at: heldAt.toISOString(),
      voucher_no: text(body?.voucherNo),
      orphan_order_id: text(body?.orphanOrderId),
      seen_while_charging_order_id: text(body?.seenWhileChargingOrderId),
      reason: text(body?.reason),
      outcome_kind: text(body?.outcomeKind),
      receipt_id: receiptId,
    })

    if (insertError) {
      /*
       * 23505 is the unique index doing its job: another request stored this record between our
       * read and our insert. The state the ruling cares about -- it exists somewhere other than
       * the device -- is satisfied, so this is an acknowledgement, not a failure. Re-read to
       * return THAT row's receiptId rather than the one we just generated and did not store.
       *
       * If the re-read comes back empty, something other than a duplicate caused the 23505 and we
       * do NOT know the record is stored. Answer 500 and let the device keep holding.
       */
      if (insertError.code === '23505') {
        const { data: raced } = await supabase
          .from('held_payments')
          .select('receipt_id')
          .eq('restaurant_id', terminal.restaurantId)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle()

        if (raced?.receipt_id) {
          return NextResponse.json({ stored: true, receiptId: String(raced.receipt_id) })
        }
        console.error('[terminal/held-payments] 23505 with no matching row', insertError)
        return NextResponse.json({ error: 'Failed to store held payment' }, { status: 500 })
      }

      console.error('[terminal/held-payments] insert failed', insertError)
      return NextResponse.json({ error: 'Failed to store held payment' }, { status: 500 })
    }

    return NextResponse.json({ stored: true, receiptId })
  } catch (err: unknown) {
    /*
     * `requireTerminalAuth` and `validateTerminalRecord` THROW A `Response`, not an Error, and it
     * already carries the right status and body. Returning it unchanged is the house pattern
     * (heartbeat, me, authorize, attempt-started all do this); an `instanceof Error` check here
     * would miss it entirely and turn every 401 into a 500.
     *
     * Whatever the status, the device reads a non-2xx as "not stored" -- which is true, because
     * nothing reached the insert.
     */
    if (err instanceof Response) return err
    console.error('[terminal/held-payments] unhandled', err)
    return NextResponse.json({ error: 'Failed to store held payment' }, { status: 500 })
  }
}
