/**
 * F2 — THE LEDGER ROW IS THE SERVER'S JOB, NOT A FIRE-AND-FORGET CALL FROM THE DEVICE.
 *
 * ==================================================================================================
 * THE MEASURED GAP
 * ==================================================================================================
 *
 * Production, read-only 2026-09-19: 1,630 orders are `payment_status = 'paid'` with
 * `payment_method = 'card'` and have NO `payment_events` sale row. N$110,027 of card revenue with
 * nothing in the ledger saying the money arrived.
 *
 * The only writer was the device, afterwards, not awaited. Terminal 9426f990,
 * `src/screens/TableDetailScreen.tsx:741`:
 *
 *     if (businessOrderNo && transactionId) {
 *       recordSaleEvent({...}, token).then(r => { if (!r.ok) console.warn(...) })
 *     } else {
 *       console.warn('[TableDetail] Skipping recordSaleEvent - missing businessOrderNo or voucherNo')
 *     }
 *
 * Three ways to lose the row and none of them is visible afterwards: the promise is never awaited,
 * nothing retries, and the whole call is skipped when either value is absent.
 *
 * ==================================================================================================
 * WHAT IS ASSERTED, AND WHERE THE REST IS
 * ==================================================================================================
 *
 * Here: the server-side writer itself -- that it writes one row, that a second call is a no-op
 * rather than a duplicate or an error, that it refuses to invent a reference it does not have, and
 * that a genuine failure is REPORTED rather than swallowed.
 *
 * supabase/tests/settlement-rpc.test.sql covers the other half: `settle_order_payment` writing the
 * ledger row inside the settlement transaction (`riviera/ledger_row_written`,
 * `riviera/ledger_amount_is_gateway_amount`, `duplicate/one_ledger_row_only`). Mutation M2 removes
 * that insert and requires those to go red.
 */
import { recordGatewaySaleEvent } from '@/lib/payments/record-gateway-sale-event'

type Row = Record<string, unknown>

function fakeSupabase(options: { onInsert?: (row: Row) => { code?: string; message?: string } | null } = {}) {
  const inserted: Row[] = []
  const client = {
    from: (table: string) => {
      if (table !== 'payment_events') throw new Error(`unexpected table ${table}`)
      return {
        insert: async (row: Row) => {
          const error = options.onInsert ? options.onInsert(row) : null
          if (!error) inserted.push(row)
          return { error }
        },
      }
    },
  }
  return { client: client as never, inserted }
}

const BASE = {
  restaurantId: 'rest-1',
  orderIds: ['ord-1', 'ord-2'],
  businessOrderNo: 'FT17887846298594421',
  transactionId: 'TXN-A',
  amount: 720,
  terminalId: 'term-1',
  source: 'terminal/tabs/settle',
}

describe('the server writes the payment ledger row', () => {
  it('writes ONE row naming every order the transaction paid for', async () => {
    const { client, inserted } = fakeSupabase()
    const result = await recordGatewaySaleEvent(client, BASE)

    expect(result).toEqual({ written: true, outcome: 'recorded' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      restaurant_id: 'rest-1',
      event_type: 'sale',
      // BOTH orders. A ledger row that named only the lead order would reproduce the Riviera
      // shape one table over.
      order_ids: ['ord-1', 'ord-2'],
      business_order_no: 'FT17887846298594421',
      origin_business_order_no: 'FT17887846298594421',
      transaction_id: 'TXN-A',
      amount: 720,
      currency: 'NAD',
      reason_code: 'sale',
    })
  })

  it('uses the gateway reference as the idempotency key — the SAME key the device uses', async () => {
    // This is what makes the two writers one ledger instead of two. If they disagreed, the
    // device's later call would insert a SECOND row for one payment.
    const { client, inserted } = fakeSupabase()
    await recordGatewaySaleEvent(client, BASE)
    expect(inserted[0].idempotency_key).toBe('FT17887846298594421')
    expect(inserted[0].idempotency_key).toBe(inserted[0].business_order_no)
  })

  it('records that the SERVER wrote it, so a row’s provenance is readable', async () => {
    const { client, inserted } = fakeSupabase()
    await recordGatewaySaleEvent(client, BASE)
    expect(inserted[0].raw_gateway_response).toMatchObject({
      recorded_by: 'server',
      source: 'terminal/tabs/settle',
    })
  })

  it('a duplicate is SUCCESS, not an error — the device may have got there first', async () => {
    const { client, inserted } = fakeSupabase({
      onInsert: () => ({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    })
    const result = await recordGatewaySaleEvent(client, BASE)

    expect(result).toEqual({ written: false, outcome: 'already_recorded' })
    expect(inserted).toHaveLength(0)
  })

  it('the transaction-id constraint counts as a duplicate too', async () => {
    // Since 2026-09-19 a second unique index can raise 23505: (restaurant_id, transaction_id).
    // It catches a retry arriving under a DIFFERENT reference for the same gateway transaction,
    // which the idempotency key alone would miss. Both mean "already recorded".
    const { client } = fakeSupabase({
      onInsert: () => ({
        code: '23505',
        message: 'duplicate key value violates unique constraint "payment_events_restaurant_transaction_id_unique"',
      }),
    })
    expect(await recordGatewaySaleEvent(client, BASE)).toEqual({
      written: false,
      outcome: 'already_recorded',
    })
  })

  it('REFUSES to invent a reference it does not have', async () => {
    /**
     * A fabricated business_order_no would produce a ledger row that matches no Finatic
     * transaction -- worse than the gap, because it LOOKS reconciled. The order stays discoverable
     * through the missing-merchant-reference report instead (F17).
     */
    const { client, inserted } = fakeSupabase()
    const result = await recordGatewaySaleEvent(client, { ...BASE, businessOrderNo: null })

    expect(result).toEqual({ written: false, outcome: 'skipped_no_reference' })
    expect(inserted).toHaveLength(0)
  })

  it('treats a blank reference the same as a missing one', async () => {
    const { client, inserted } = fakeSupabase()
    expect(await recordGatewaySaleEvent(client, { ...BASE, businessOrderNo: '   ' })).toEqual({
      written: false,
      outcome: 'skipped_no_reference',
    })
    expect(inserted).toHaveLength(0)
  })

  it('refuses a non-positive amount rather than recording a collection of nothing', async () => {
    const { client, inserted } = fakeSupabase()
    const result = await recordGatewaySaleEvent(client, { ...BASE, amount: 0 })
    expect(result.written).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(inserted).toHaveLength(0)
  })

  it('REPORTS a real failure instead of swallowing it', async () => {
    /**
     * The defect being closed is silence. A ledger row that fails to write must be visible at the
     * call site -- the settle route carries this into `sale_event` in both its audit metadata and
     * its response -- rather than logged and forgotten the way the device's `.then()` does it.
     */
    const { client } = fakeSupabase({
      onInsert: () => ({ code: '42703', message: 'column "nope" does not exist' }),
    })
    const result = await recordGatewaySaleEvent(client, BASE)

    expect(result.written).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/does not exist/)
  })

  it('never throws, because every caller reaches it AFTER the money has moved', async () => {
    /**
     * A REJECTED insert -- a dropped socket, an aborted Worker fetch -- arrives as a thrown
     * exception rather than as `{ error }`. Letting it escape would land in the calling route's
     * outer catch, which answers 401 for a settlement that has already succeeded and invites a
     * retry against orders that are already claimed.
     *
     * The first version of this test asserted `.rejects.toThrow()`, which passed against a helper
     * whose own docblock promised the opposite. The helper was wrong, not the contract.
     */
    const { client } = fakeSupabase({
      onInsert: () => {
        throw new Error('network exploded')
      },
    })

    const result = await recordGatewaySaleEvent(client, BASE)
    expect(result.written).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/network exploded/)
  })
})

describe('the settle route writes the ledger row itself', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  const source = () =>
    readFileSync(join(process.cwd(), 'app/api/terminal/tabs/[tabId]/settle/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('calls the server-side ledger writer', () => {
    expect(source()).toMatch(/recordGatewaySaleEvent\(/)
  })

  it('passes the SERVER’s amount, never the client’s', () => {
    // `amount` is the device's figure and is only ever a cross-check; `expectedAmount` is what the
    // server computed from its own rows and is what gets stored everywhere else in this route.
    const code = source()
    const call = code.slice(code.indexOf('recordGatewaySaleEvent('))
    expect(call.slice(0, 900)).toMatch(/amount:\s*expectedAmount/)
    expect(call.slice(0, 900)).not.toMatch(/amount:\s*amount\b/)
  })

  it('surfaces the outcome rather than letting a missing ledger row be silent', () => {
    expect(source()).toMatch(/sale_event/)
  })
})
