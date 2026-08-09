/**
 * #156 — the hourly per-venue SALE coverage check.
 *
 * The requirement it has to meet is specific and testable: the July outage ran at ~1% missing
 * on 23 July, 40% on 27 July, 94% on 28 July and 100% from 29 July, and the check must fire on
 * 27 July. The thresholds are therefore driven directly with the real figures from the
 * Discovery Note rather than with invented ones, so a future change to the constants that
 * would have missed the outage fails here.
 *
 * The other property under test is that it REPORTS and never BLOCKS. It fires on pre-existing
 * history by construction -- 294 card payments already have no SALE row -- so anything that
 * let it gate a request would be switched off within the week.
 */
import { FakeDb } from './helpers/fake-payment-events-db'
import {
  assessVenueCoverage,
  COVERAGE_MIN_SAMPLE,
  COVERAGE_MISSING_RATIO_THRESHOLD,
  reconcileSaleLedgerCoverage,
  SALE_LEDGER_COVERAGE_DEGRADED_ACTION,
  SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
} from '@/lib/payments/reconcile-sale-ledger-coverage'

const fire = (paidCount: number, missingCount: number, previousMissingRatio: number | null = null) =>
  assessVenueCoverage({ paidCount, missingCount, previousMissingRatio }).degraded

/* ------------------------------------------------------------------ *
 * Driven with the actual outage.
 * ------------------------------------------------------------------ */
describe('the ratio rule against the real July figures', () => {
  it('stays quiet on the healthy days at volume', () => {
    expect(fire(100, 0)).toBe(false) // 22 Jul, FNB ChowNow: 0/100
    expect(fire(176, 2)).toBe(false) // 23 Jul, FNB ChowNow: 2/176  (1%)
    expect(fire(170, 4)).toBe(false) // 24 Jul, FNB ChowNow: 4/170  (2.4%)
  })

  it('FIRES on 27 July — the day the check is required to catch', () => {
    expect(fire(45, 18)).toBe(true) // 27 Jul, FNB ChowNow: 18/45  (40%)
  })

  it('fires on the days after, as the outage deepens', () => {
    expect(fire(32, 30)).toBe(true) // 28 Jul, FNB ChowNow: 30/32  (94%)
    expect(fire(117, 117)).toBe(true) // 29 Jul, FNB ChowNow: total failure
    expect(fire(17, 3)).toBe(true) // 28 Jul, Mingle: 3/17  (17.6%)
    expect(fire(22, 22)).toBe(true) // 29 Jul, Mingle: total failure
  })

  it('catches a small venue in total failure that a count threshold would miss', () => {
    // Riviera's complete failure is 7 orders. Any absolute-count threshold high enough not to
    // fire on a busy healthy venue would be silent here, which is why this is a ratio.
    expect(fire(7, 7)).toBe(true)
  })

  it('does not fire on a tiny sample where one miss is 100%', () => {
    expect(fire(1, 1)).toBe(false)
    expect(fire(COVERAGE_MIN_SAMPLE - 1, COVERAGE_MIN_SAMPLE - 1)).toBe(false)
  })

  it('the threshold sits between the worst healthy day and the first bad one', () => {
    // 2.4% healthy ceiling, 40% first outage day. A change that moves the constant outside
    // that band silently breaks the calibration, so it is asserted rather than assumed.
    expect(COVERAGE_MISSING_RATIO_THRESHOLD).toBeGreaterThan(4 / 170)
    expect(COVERAGE_MISSING_RATIO_THRESHOLD).toBeLessThan(18 / 45)
  })

  it('never fires when nothing is missing', () => {
    expect(fire(500, 0)).toBe(false)
    expect(fire(0, 0)).toBe(false)
  })
})

describe('the sharp-degradation rule catches the slope earlier than the ratio rule', () => {
  it('fires when a healthy venue multiplies its miss rate', () => {
    // 1% -> 8% is below the 15% ratio threshold but is an eightfold degradation.
    expect(fire(100, 8, 0.01)).toBe(true)
  })

  it('does not fire on noise above a healthy base', () => {
    expect(fire(200, 4, 0.01)).toBe(false) // 2%, under the 5% floor
  })

  it('does not fire when the rate is flat', () => {
    expect(fire(176, 2, 2 / 176)).toBe(false)
  })

  it('does not fire when the rate is IMPROVING', () => {
    expect(fire(100, 6, 0.5)).toBe(false)
  })

  it('reports which rule fired, so the alert says why', () => {
    expect(assessVenueCoverage({ paidCount: 45, missingCount: 18, previousMissingRatio: null }).trigger)
      .toMatch(/threshold/)
    expect(assessVenueCoverage({ paidCount: 100, missingCount: 8, previousMissingRatio: 0.01 }).trigger)
      .toMatch(/rose from/)
  })
})

/* ------------------------------------------------------------------ *
 * End to end over the fake, per venue.
 * ------------------------------------------------------------------ */
const NOW = new Date('2026-07-27T12:00:00.000Z')
const IN_WINDOW = new Date('2026-07-27T11:30:00.000Z').toISOString()

function seedOrder(
  db: FakeDb,
  id: string,
  restaurantId: string,
  opts: { method?: string; status?: string; paidAt?: string } = {},
) {
  db.tables.orders.push({
    id,
    restaurant_id: restaurantId,
    payment_status: opts.status ?? 'paid',
    payment_method: opts.method ?? 'card',
    paid_at: opts.paidAt ?? IN_WINDOW,
  })
}

function seedSale(db: FakeDb, orderIds: string[], restaurantId: string) {
  db.tables.payment_events.push({
    id: `pe-${orderIds.join('-')}`,
    restaurant_id: restaurantId,
    event_type: 'sale',
    order_ids: orderIds,
    business_order_no: `FT-${orderIds[0]}`,
    origin_business_order_no: `FT-${orderIds[0]}`,
    amount: 10,
    idempotency_key: `FT-${orderIds[0]}`,
    reason_code: 'sale',
  })
}

describe('per-venue reconciliation over the fake', () => {
  it('counts a card order with no SALE row as missing', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'o1', 'v1')
    seedOrder(db, 'o2', 'v1')
    seedSale(db, ['o1'], 'v1')

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.venues).toHaveLength(1)
    expect(report!.venues[0].paidCount).toBe(2)
    expect(report!.venues[0].missingCount).toBe(1)
    expect(report!.venues[0].missingOrderIds).toEqual(['o2'])
  })

  it('does NOT count cash orders as missing — they are excluded by design', async () => {
    // Counting them would report a permanent unfixable gap every hour.
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'cash1', 'v1', { method: 'cash' })
    seedOrder(db, 'cash2', 'v1', { method: 'cash' })

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.totals.paidCount).toBe(0)
    expect(report!.totals.missingCount).toBe(0)
  })

  it('reports each venue separately — simultaneous failure is itself diagnostic', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' }, { id: 'v2', name: 'Mingle' })
    for (let i = 0; i < 10; i++) seedOrder(db, `a${i}`, 'v1')
    for (let i = 0; i < 10; i++) seedOrder(db, `b${i}`, 'v2')
    for (let i = 0; i < 10; i++) seedSale(db, [`b${i}`], 'v2') // Mingle fully covered

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    const v1 = report!.venues.find((v) => v.restaurantId === 'v1')!
    const v2 = report!.venues.find((v) => v.restaurantId === 'v2')!
    expect(v1.missingCount).toBe(10)
    expect(v1.degraded).toBe(true)
    expect(v2.missingCount).toBe(0)
    expect(v2.degraded).toBe(false)
    expect(v1.restaurantName).toBe('FNB ChowNow')
  })

  it('ignores orders outside the window', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'old', 'v1', { paidAt: '2026-07-20T00:00:00.000Z' })

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.totals.paidCount).toBe(0)
  })

  it('does not treat an unpaid or cancelled order as a missing sale', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'x1', 'v1', { status: 'cancelled' })
    seedOrder(db, 'x2', 'v1', { status: 'pending' })

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.totals.paidCount).toBe(0)
  })

  it('normalises payment_status, so a stray "Paid" is not a blind spot', async () => {
    // A byte-exact .eq('payment_status','paid') would silently miss this row. A check that
    // exists to find missing records must not have gaps of its own.
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'p1', 'v1', { status: ' Paid ' })

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.totals.paidCount).toBe(1)
    expect(report!.totals.missingCount).toBe(1)
  })

  it('matches a tab-settlement SALE row that covers several orders at once', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 't1', 'v1')
    seedOrder(db, 't2', 'v1')
    seedOrder(db, 't3', 'v1')
    seedSale(db, ['t1', 't2', 't3'], 'v1')

    const { report } = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(report!.totals.missingCount).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * Observability, and the guarantee that it reports rather than blocks.
 * ------------------------------------------------------------------ */
describe('the check is observable and non-blocking', () => {
  it('writes a heartbeat row even when nothing is wrong', async () => {
    // The auto-cancel cron failed silently for three days because a job that stops running
    // looks exactly like a job with nothing to report.
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    seedOrder(db, 'o1', 'v1')
    seedSale(db, ['o1'], 'v1')

    await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(db.auditRows(SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION)).toHaveLength(1)
    expect(db.auditRows(SALE_LEDGER_COVERAGE_DEGRADED_ACTION)).toHaveLength(0)
  })

  it('writes a degraded row, scoped to the venue, when a venue breaches', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    for (let i = 0; i < 10; i++) seedOrder(db, `a${i}`, 'v1')

    await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    const degraded = db.auditRows(SALE_LEDGER_COVERAGE_DEGRADED_ACTION)
    expect(degraded).toHaveLength(1)
    expect(degraded[0].restaurant_id).toBe('v1')
    const meta = degraded[0].metadata as Record<string, unknown>
    expect(meta.requiresAttention).toBe(true)
    expect(meta.missingCount).toBe(10)
    expect(meta.trigger).toBeTruthy()
  })

  it('reports ok:false rather than throwing when the orders read fails', async () => {
    const db = new FakeDb({ failSelectOn: { orders: { message: 'orders read failed' } } })

    const result = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('orders read failed')
  })

  it('a failed payment_events read is never reported as "no SALE rows"', async () => {
    // The dangerous failure mode: a transport error rendered as a total outage, which would
    // fire a critical alert on every venue and get the check muted.
    const db = new FakeDb({ failSelectOn: { payment_events: { message: 'ledger read failed' } } })
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    for (let i = 0; i < 10; i++) seedOrder(db, `a${i}`, 'v1')

    const result = await reconcileSaleLedgerCoverage(db.client() as never, { now: NOW })

    expect(result.ok).toBe(false)
    expect(db.auditRows(SALE_LEDGER_COVERAGE_DEGRADED_ACTION)).toHaveLength(0)
  })

  it('dryRun writes nothing at all', async () => {
    const db = new FakeDb()
    db.tables.restaurants.push({ id: 'v1', name: 'FNB ChowNow' })
    for (let i = 0; i < 10; i++) seedOrder(db, `a${i}`, 'v1')

    const result = await reconcileSaleLedgerCoverage(db.client() as never, {
      now: NOW,
      dryRun: true,
    })

    expect(result.report!.venues[0].degraded).toBe(true)
    expect(db.tables.audit_logs).toHaveLength(0)
  })
})
