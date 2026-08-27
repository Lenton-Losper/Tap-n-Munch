/**
 * #156 — the sweep that would have caught the ledger dying on 28 July.
 *
 * The assertions that carry weight here are the ones about NOT reporting an all-clear. A detector
 * that says "0 missing" when it looked at nothing is exactly what the duplicate-charge detector
 * did for a month: it read an empty ledger and reported no duplicates, and the absence of evidence
 * was read as evidence of absence.
 */
import {
  reportCardPaymentsWithoutSaleRow,
  SALE_ROW_GRACE_MINUTES,
} from '@/lib/payments/report-card-payments-without-sale-row'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const paidAt = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

/** A fake that records the filters applied, so the query's shape can be asserted too. */
function fakeDb(orders: any[], saleRows: any[], seen: Record<string, unknown> = {}) {
  const chain = (rows: any[], tag: string) => {
    const api: any = {
      select: () => api,
      eq: (k: string, v: unknown) => { seen[`${tag}.eq.${k}`] = v; return api },
      not: (k: string, op: string, v: unknown) => { seen[`${tag}.not.${k}`] = `${op} ${v}`; return api },
      gte: (k: string, v: unknown) => { seen[`${tag}.gte.${k}`] = v; return api },
      lte: (k: string, v: unknown) => { seen[`${tag}.lte.${k}`] = v; return api },
      order: () => api,
      limit: () => Promise.resolve({ data: rows, error: null }),
    }
    return api
  }
  return {
    from: (t: string) => (t === 'orders' ? chain(orders, 'orders') : chain(saleRows, 'events')),
  }
}

const order = (id: string, over: Record<string, unknown> = {}) => ({
  id, order_number: 1, total: 20, paid_at: paidAt(60),
  paycloud_merchant_order_no: 'FT1', restaurant_id: 'r1',
  restaurants: { name: 'Mingle Brew & Pour' }, ...over,
})

describe('#156 sale-row gap detection', () => {
  it('reports the July shape: every card payment missing its ledger row', async () => {
    const r = await reportCardPaymentsWithoutSaleRow(
      fakeDb([order('a'), order('b'), order('c')], []), { nowMs: NOW },
    )
    expect(r.scanned).toBe(3)
    expect(r.missing).toBe(3)
    expect(r.missingRatio).toBe(1)
    // The ratio is what distinguishes "the writer is broken" from "three incidents".
    expect(r.worst[0].restaurantName).toBe('Mingle Brew & Pour')
  })

  it('reports zero missing when every payment has a row', async () => {
    const r = await reportCardPaymentsWithoutSaleRow(
      fakeDb([order('a'), order('b')], [{ order_ids: ['a', 'b'] }]), { nowMs: NOW },
    )
    expect(r.scanned).toBe(2)
    expect(r.missing).toBe(0)
    expect(r.missingRatio).toBe(0)
  })

  it('does NOT count a payment inside the grace window as missing', async () => {
    // Still legitimately in flight. Counting it would make the detector cry wolf on every sale
    // and train everyone to ignore it -- which is how the alert-sound indicator's docblock
    // describes a status readout dying.
    const seen: Record<string, unknown> = {}
    await reportCardPaymentsWithoutSaleRow(fakeDb([], [], seen), { nowMs: NOW })
    const cutoff = Date.parse(String(seen['orders.lte.paid_at']))
    expect(NOW - cutoff).toBe(SALE_ROW_GRACE_MINUTES * 60_000)
  })

  it('EXCLUDES stress fixtures, which would poison the ratio', async () => {
    // 1,314 of ~3,516 production orders carry restaurant_id IS NULL. Including them would make
    // the missing-ratio meaningless in exactly the direction that hides a real gap.
    const seen: Record<string, unknown> = {}
    await reportCardPaymentsWithoutSaleRow(fakeDb([], [], seen), { nowMs: NOW })
    expect(seen['orders.not.restaurant_id']).toBe('is null')
  })

  it('only looks at PAID orders', async () => {
    const seen: Record<string, unknown> = {}
    await reportCardPaymentsWithoutSaleRow(fakeDb([], [], seen), { nowMs: NOW })
    expect(seen['orders.eq.payment_status']).toBe('paid')
  })

  it('only counts SALE events, not some future event type', async () => {
    // Needs a card payment present: with none, the function short-circuits before querying
    // payment_events at all -- correctly, since there is nothing to check. Passing an empty
    // order list here asserted on a query that never ran, which is the same vacuous-pass shape
    // as a test whose subject was never reached.
    const seen: Record<string, unknown> = {}
    await reportCardPaymentsWithoutSaleRow(fakeDb([order('a')], [], seen), { nowMs: NOW })
    expect(seen['events.eq.event_type']).toBe('sale')
  })

  it('treats a missing payment_method as CARD, matching the ledger\'s own convention', async () => {
    const r = await reportCardPaymentsWithoutSaleRow(
      fakeDb([order('a', { payment_method: undefined })], []), { nowMs: NOW },
    )
    // If this ever defaulted the other way, a card payment with no method column would vanish
    // from the denominator and the gap would look smaller than it is.
    expect(r.scanned).toBe(1)
    expect(r.missing).toBe(1)
  })

  it('does not count CASH payments, which legitimately write no sale row', async () => {
    const r = await reportCardPaymentsWithoutSaleRow(
      fakeDb([order('a', { payment_method: 'cash' })], []), { nowMs: NOW },
    )
    expect(r.scanned).toBe(0)
    expect(r.missing).toBe(0)
  })

  it('scanned=0 means NOTHING WAS TESTABLE, and must not read as an all-clear', async () => {
    // The load-bearing assertion. The route branches on scanned===0 to say "nothing to check"
    // rather than "none missing" -- because reporting the absence of trade as a working ledger is
    // the precise defect that let #156 run for a month.
    const r = await reportCardPaymentsWithoutSaleRow(fakeDb([], []), { nowMs: NOW })
    expect(r.scanned).toBe(0)
    expect(r.missing).toBe(0)
    expect(r.missingRatio).toBe(0)
  })
})
