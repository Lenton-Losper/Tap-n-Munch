import { readFileSync } from 'node:fs'
import {
  recordRefusedSecondPayment,
  SECOND_PAYMENT_REFUSED_ACTION,
} from '@/lib/payments/record-refused-second-payment'

/**
 * #329 follow-up — THE 409 PATH LEAVES A TRACE.
 *
 * A second success callback for an already-paid order is refused by an atomic claim and answered
 * 409. That protects the bookkeeping and nothing else: the card was charged on the DEVICE before
 * this server was involved, so by the time the 409 is written the money has already moved. Until
 * 2026-08-24 that branch returned without writing anything, so the one moment the system learns a
 * card may have been charged twice produced no record at all.
 *
 * The load-bearing assertion is not "a row is written" — it is that the row DISTINGUISHES a repeated
 * callback for one transaction from a second transaction. Those are the same HTTP exchange and
 * completely different events, and only the reference pair tells them apart.
 */

function fakeSupabase() {
  const inserts: Record<string, unknown>[] = []
  return {
    inserts,
    client: {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserts.push(row)
          return Promise.resolve({ error: null })
        },
      }),
    },
  }
}

const base = {
  orderId: 'order-1',
  restaurantId: 'rest-1',
  reason: 'already_paid' as const,
  orderTotal: 55,
  amountClaimed: 55,
  terminalId: 'term-1',
  source: 'terminal/orders/payment',
}

describe('the row tells a repeat apart from a second charge', () => {
  it('flags a DIFFERENT gateway reference as a distinct transaction', async () => {
    const { client, inserts } = fakeSupabase()
    await recordRefusedSecondPayment(client as never, {
      ...base,
      attemptedReference: 'REF-SECOND',
      attemptedBusinessOrderNo: 'FT-SECOND',
      existingReference: 'REF-FIRST',
      existingBusinessOrderNo: 'FT-FIRST',
    })
    const md = (inserts[0] as { metadata: Record<string, unknown> }).metadata
    expect(md.distinctGatewayTransaction).toBe(true)
    expect(String(md.note)).toMatch(/charged twice/i)
  })

  it('does NOT flag a repeated callback for the same transaction', async () => {
    // The same reference arriving twice is a device or network repeat. One charge exists. Flagging
    // it would bury the real ones in noise, which is how a signal stops being read.
    const { client, inserts } = fakeSupabase()
    await recordRefusedSecondPayment(client as never, {
      ...base,
      attemptedReference: 'REF-FIRST',
      attemptedBusinessOrderNo: 'FT-FIRST',
      existingReference: 'REF-FIRST',
      existingBusinessOrderNo: 'FT-FIRST',
    })
    const md = (inserts[0] as { metadata: Record<string, unknown> }).metadata
    expect(md.distinctGatewayTransaction).toBe(false)
    expect(String(md.note)).toMatch(/One charge exists/i)
  })

  it('does not flag when either reference is missing, rather than guessing', async () => {
    // A missing reference is unknown, not different. Treating absence as a distinct transaction
    // would raise a double-charge alarm on every stale APK that sends no reference at all.
    const { client, inserts } = fakeSupabase()
    await recordRefusedSecondPayment(client as never, {
      ...base,
      attemptedReference: null,
      attemptedBusinessOrderNo: null,
      existingReference: 'REF-FIRST',
      existingBusinessOrderNo: 'FT-FIRST',
    })
    expect((inserts[0] as { metadata: Record<string, unknown> }).metadata.distinctGatewayTransaction).toBe(false)
  })

  it('records BOTH references, so the row is readable on its own', async () => {
    // The order's reference is whatever the FIRST payment wrote and never changes, so the
    // comparison cannot be reconstructed later by joining back to the order.
    const { client, inserts } = fakeSupabase()
    await recordRefusedSecondPayment(client as never, {
      ...base,
      attemptedReference: 'REF-SECOND',
      attemptedBusinessOrderNo: 'FT-SECOND',
      existingReference: 'REF-FIRST',
      existingBusinessOrderNo: 'FT-FIRST',
    })
    const md = (inserts[0] as { metadata: Record<string, unknown> }).metadata
    expect(md.attemptedBusinessOrderNo).toBe('FT-SECOND')
    expect(md.existingBusinessOrderNo).toBe('FT-FIRST')
    expect(md.orderTotal).toBe(55)
  })

  it('uses an action of its own, distinct from a cancel or a status change', async () => {
    expect(SECOND_PAYMENT_REFUSED_ACTION).toBe('payment.refused_already_paid')
    expect(SECOND_PAYMENT_REFUSED_ACTION).not.toBe('order.cancelled')
  })
})

describe('recording can never change the refusal', () => {
  it('returns false instead of throwing when the insert throws', async () => {
    // The 409 is the correct answer and must be returned whatever happens here. A logging failure
    // turning a correct refusal into a 500 is the same inversion #329 corrected.
    const client = { from: () => { throw new Error('no audit_logs in this client') } }
    await expect(
      recordRefusedSecondPayment(client as never, {
        ...base,
        attemptedReference: 'a',
        attemptedBusinessOrderNo: 'a',
        existingReference: 'b',
        existingBusinessOrderNo: 'b',
      }),
    ).resolves.toBe(false)
  })

  it('returns false instead of throwing when the insert errors', async () => {
    const client = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'nope' } }) }) }
    await expect(
      recordRefusedSecondPayment(client as never, {
        ...base,
        attemptedReference: 'a',
        attemptedBusinessOrderNo: 'a',
        existingReference: 'b',
        existingBusinessOrderNo: 'b',
      }),
    ).resolves.toBe(false)
  })
})

describe('the route actually calls it', () => {
  const ROUTE = readFileSync('app/api/terminal/orders/[orderId]/payment/route.ts', 'utf8')

  it('records before returning the 409', () => {
    const call = ROUTE.indexOf('recordRefusedSecondPayment(')
    const claim = ROUTE.indexOf('if (!result.claimed)')
    expect(call).toBeGreaterThan(claim)
    expect(call).toBeGreaterThan(-1)
  })

  it('reads payment_reference on the order, or the comparison is impossible', () => {
    // Without this column in the SELECT the existing reference is always undefined and every
    // refusal would be reported as "not distinct" — a silent always-false flag.
    //
    // MATCHED INSIDE THE SELECT STRING, not anywhere in the file. The first version of this
    // assertion was `toMatch(/payment_reference/)`, which passed when the column was removed
    // from the query because the COMMENT above it still contained the word. A source-text
    // assertion has to name where the text must be, or it pins prose.
    expect(ROUTE).toMatch(/'id, tab_id[^']*payment_reference'/)
  })

  it('compares against the row read BEFORE the merchant-order safety net', () => {
    // The safety net writes businessOrderNo onto an order whose column is null. If the comparison
    // used a row re-read after that, this attempt's own value would appear as the existing one and
    // a second transaction would look identical to a repeat.
    const select = ROUTE.indexOf('payment_reference')
    const safetyNet = ROUTE.indexOf('paycloud_merchant_order_no: businessOrderNo.slice(0, 32)')
    expect(select).toBeLessThan(safetyNet)
  })
})
