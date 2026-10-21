/**
 * Payment-method breakdown: the aggregation contract (lib/analytics/payment-method-breakdown.ts).
 *
 * The original chart drew Card and Cash only; `other` and `paytoday` paid orders were counted and
 * then dropped, so the visible slices summed to less than 100%. These tests pin the replacement:
 * every ledger method shown, unknown values kept in their own bucket, transactions (ledger rows)
 * kept apart from orders, refunds kept apart from collections, and percentages that reconcile.
 *
 * Venue time is Africa/Windhoek, UTC+2 with no DST: 22:00Z is local midnight.
 */
import {
  buildPaymentMethodBreakdown,
  normalizeMethod,
  reconcilePercentages,
  SETTLEMENT_LEDGER_RELIABLE_FROM,
  type PaidOrder,
  type RefundEvent,
  type SettlementEvent,
} from '@/lib/analytics/payment-method-breakdown'

let n = 0
const ev = (p: Partial<SettlementEvent> & { createdAt: string }): SettlementEvent => ({
  id: `e${++n}`,
  source: 'non_gateway',
  method: 'cash',
  amountCents: 1000,
  orderIds: [`o${n}`],
  ...p,
})
const gw = (createdAt: string, amountCents = 5000, orderIds?: string[]): SettlementEvent =>
  ev({ source: 'gateway', method: null, createdAt, amountCents, orderIds: orderIds ?? [`g${n + 1}`] })
const refund = (createdAt: string, amountCents: number, id?: string): RefundEvent => ({
  id: id ?? `r${++n}`,
  amountCents,
  createdAt,
  orderIds: ['x'],
})
const order = (id: string, paymentMethod: string | null, paidAt: string, totalCents = 2000): PaidOrder => ({
  id,
  paymentMethod,
  totalCents,
  paidAt,
})

const D = '2026-10-10'
const NOON = `${D}T10:00:00Z`
const base = { startDate: D, endDate: D, timeZone: 'Africa/Windhoek' as const }
const empty = { events: [], refunds: [], paidOrders: [] }

const rowOf = (b: ReturnType<typeof buildPaymentMethodBreakdown>, m: string) =>
  b.settlement!.rows.find((r) => r.method === m)

describe('every recorded method appears, with counts, amounts and reconciling percentages', () => {
  const events = [
    gw(NOON, 5000),
    gw(NOON, 7000),
    ev({ createdAt: NOON, method: 'cash', amountCents: 3000 }),
    ev({ createdAt: NOON, method: 'cash', amountCents: 1000 }),
    ev({ createdAt: NOON, method: 'card', amountCents: 2000 }), // standalone card machine
    ev({ createdAt: NOON, method: 'paytoday', amountCents: 400 }),
    ev({ createdAt: NOON, method: 'other', amountCents: 600 }),
  ]
  const b = buildPaymentMethodBreakdown({ ...base, events, refunds: [], paidOrders: [] })

  it('lists card, cash, paytoday and other', () => {
    expect(b.settlement!.rows.map((r) => r.method).sort()).toEqual(['card', 'cash', 'other', 'paytoday'])
    expect(rowOf(b, 'other')!.label).toBe('Other')
    expect(rowOf(b, 'paytoday')!.label).toBe('PayToday')
  })

  it('merges gateway sales and card-machine rows into one card row without double counting', () => {
    expect(rowOf(b, 'card')).toMatchObject({ count: 3, amountCents: 14000 })
  })

  it('percentages of count and of amount each sum to exactly 100.0', () => {
    const rows = b.settlement!.rows
    expect(rows.reduce((s, r) => s + Math.round(r.percentOfCount * 10), 0)).toBe(1000)
    expect(rows.reduce((s, r) => s + Math.round(r.percentOfAmount * 10), 0)).toBe(1000)
  })

  it('row counts and amounts add up to the section total (the legend reconciles)', () => {
    const s = b.settlement!
    expect(s.rows.reduce((a, r) => a + r.count, 0)).toBe(s.total.count)
    expect(s.rows.reduce((a, r) => a + r.amountCents, 0)).toBe(s.total.amountCents)
    expect(s.total.count).toBe(events.length)
    expect(s.denominatorLabel).toMatch(/^7 successful collection transactions/)
  })
})

describe('unknown, future, legacy and mixed-case values', () => {
  it('keeps an unrecognised method in its own labelled bucket instead of dropping or merging it', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: [ev({ createdAt: NOON, method: 'Voucher ' }), ev({ createdAt: NOON, method: 'cash' })],
    })
    const row = rowOf(b, 'voucher')!
    expect(row).toMatchObject({ count: 1, known: false, label: 'voucher (unrecognised)' })
    expect(row.validation).toMatch(/not a payment method FlashTap records/)
    expect(b.settlement!.total.count).toBe(2)
  })

  it('normalises case and whitespace, so CASH, " Cash" and cash are one row', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: ['CASH', ' Cash', 'cash'].map((m) => ev({ createdAt: NOON, method: m })),
    })
    expect(b.settlement!.rows).toHaveLength(1)
    expect(rowOf(b, 'cash')!.count).toBe(3)
  })

  it('null and empty methods become the "unknown" bucket, never cash', () => {
    expect(normalizeMethod(null)).toBe('unknown')
    expect(normalizeMethod('   ')).toBe('unknown')
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: [ev({ createdAt: NOON, method: null }), ev({ createdAt: NOON, method: 'cash' })],
    })
    expect(rowOf(b, 'unknown')).toMatchObject({ count: 1, label: 'Unrecorded', known: true })
    expect(rowOf(b, 'cash')!.count).toBe(1)
  })

  it('flags "other" for validation with its date span, without calling it test traffic', () => {
    const b = buildPaymentMethodBreakdown({
      startDate: '2026-10-10',
      endDate: '2026-10-12',
      ...empty,
      events: [
        ev({ createdAt: '2026-10-10T10:00:00Z', method: 'other', terminalId: 't1' }),
        ev({ createdAt: '2026-10-12T10:00:00Z', method: 'other', terminalId: 't2' }),
      ],
    })
    const v = rowOf(b, 'other')!.validation!
    expect(v).toContain('2026-10-10 to 2026-10-12')
    expect(v).toContain('2 terminals')
    expect(v).toMatch(/Not classified as real or test traffic/)
    expect(rowOf(b, 'other')).toMatchObject({ firstDay: '2026-10-10', lastDay: '2026-10-12', activeDays: 2 })
  })
})

describe('empty results', () => {
  it('returns zero totals, no rows and no NaN percentages', () => {
    const b = buildPaymentMethodBreakdown({ ...base, ...empty })
    expect(b.settlement!.rows).toEqual([])
    expect(b.settlement!.total).toEqual({ count: 0, amountCents: 0, ordersCovered: 0 })
    expect(b.coverage.uncoveredOrders).toBe(0)
    expect(b.refunds).toEqual({ count: 0, amountCents: 0, netOfRefundsCents: 0 })
    expect(b.settlement!.daily).toHaveLength(1)
  })

  it('reconcilePercentages gives zeros, not NaN, for an empty or all-zero population', () => {
    expect(reconcilePercentages([])).toEqual([])
    expect(reconcilePercentages([0, 0])).toEqual([0, 0])
  })
})

describe('split payments: transactions are ledger rows, orders are counted apart', () => {
  it('one order paid half cash, half card is ONE order and TWO transactions', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: [
        ev({ createdAt: NOON, method: 'cash', amountCents: 500, orderIds: ['o-split'] }),
        ev({ createdAt: NOON, method: 'card', amountCents: 500, orderIds: ['o-split'] }),
      ],
    })
    expect(b.settlement!.total).toEqual({ count: 2, amountCents: 1000, ordersCovered: 1 })
    expect(rowOf(b, 'cash')!.ordersCovered).toBe(1)
    expect(rowOf(b, 'card')!.ordersCovered).toBe(1)
  })

  it('one tab settlement over three orders is ONE transaction covering THREE orders', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: [ev({ createdAt: NOON, method: 'cash', amountCents: 9000, orderIds: ['a', 'b', 'c'] })],
    })
    expect(b.settlement!.total).toEqual({ count: 1, amountCents: 9000, ordersCovered: 3 })
  })

  it('a split order is not reported as a coverage gap', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      events: [ev({ createdAt: NOON, orderIds: ['o-split'] })],
      refunds: [],
      paidOrders: [order('o-split', 'cash', NOON)],
    })
    expect(b.coverage.uncoveredOrders).toBe(0)
  })
})

describe('duplicates', () => {
  it('drops a repeated row id once, and says how many it dropped', () => {
    const e = ev({ createdAt: NOON, amountCents: 700 })
    const b = buildPaymentMethodBreakdown({ ...base, ...empty, events: [e, { ...e }, ev({ createdAt: NOON })] })
    expect(b.settlement!.total.count).toBe(2)
    expect(b.droppedDuplicateRows).toBe(1)
  })

  it('two distinct rows with the same amount and order are two transactions (no guessed business key)', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      ...empty,
      events: [
        ev({ createdAt: NOON, amountCents: 500, orderIds: ['same'] }),
        ev({ createdAt: NOON, amountCents: 500, orderIds: ['same'] }),
      ],
    })
    expect(b.settlement!.total.count).toBe(2)
    expect(b.droppedDuplicateRows).toBe(0)
  })

  it('drops a repeated refund id', () => {
    const r = refund(NOON, 3500, 'dup')
    const b = buildPaymentMethodBreakdown({ ...base, ...empty, refunds: [r, { ...r }] })
    expect(b.refunds.count).toBe(1)
    expect(b.droppedDuplicateRows).toBe(1)
  })
})

describe('date boundaries and venue time zone', () => {
  const at = (iso: string) => ev({ createdAt: iso, method: 'cash' })
  const count = (startDate: string, endDate: string, events: SettlementEvent[], timeZone?: string) =>
    buildPaymentMethodBreakdown({ startDate, endDate, timeZone, ...empty, events }).settlement!.total.count

  it('23:59:59 and 00:00:00 local fall on different days', () => {
    const lastSecond = at('2026-10-10T21:59:59Z') // 23:59:59 on the 10th, Windhoek
    const firstSecond = at('2026-10-10T22:00:00Z') // 00:00:00 on the 11th
    expect(count('2026-10-10', '2026-10-10', [lastSecond, firstSecond])).toBe(1)
    expect(count('2026-10-11', '2026-10-11', [lastSecond, firstSecond])).toBe(1)
    expect(count('2026-10-10', '2026-10-11', [lastSecond, firstSecond])).toBe(2)
  })

  it('groups by the venue zone, not the UTC date or the zone of the viewer', () => {
    const lateUtc = at('2026-10-10T23:30:00Z') // 11th in Windhoek, 10th in New York
    expect(count('2026-10-11', '2026-10-11', [lateUtc], 'Africa/Windhoek')).toBe(1)
    expect(count('2026-10-10', '2026-10-10', [lateUtc], 'America/New_York')).toBe(1)
    expect(count('2026-10-10', '2026-10-10', [lateUtc], 'Africa/Windhoek')).toBe(0)
  })

  it('daily rows cover every day in the range, zero days included, and sum to the totals', () => {
    const b = buildPaymentMethodBreakdown({
      startDate: '2026-10-08',
      endDate: '2026-10-11',
      ...empty,
      events: [
        at('2026-10-08T08:00:00Z'),
        at('2026-10-08T09:00:00Z'),
        gw('2026-10-11T08:00:00Z', 4000),
      ],
    })
    const daily = b.settlement!.daily
    expect(daily.map((d) => d.day)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
    expect(daily[1].total).toEqual({ count: 0, amountCents: 0 })
    expect(daily.reduce((s, d) => s + d.total.count, 0)).toBe(b.settlement!.total.count)
    expect(daily.reduce((s, d) => s + d.total.amountCents, 0)).toBe(b.settlement!.total.amountCents)
  })

  it('rows outside the requested days (the fetch margin) never reach the totals', () => {
    expect(count(D, D, [at('2026-10-09T10:00:00Z'), at(NOON), at('2026-10-11T10:00:00Z')])).toBe(1)
  })

  it('a row with an unparseable timestamp is counted and reported, not silently kept or dropped', () => {
    const b = buildPaymentMethodBreakdown({ ...base, ...empty, events: [at('not-a-date'), at(NOON)] })
    expect(b.settlement!.total.count).toBe(1)
    expect(b.rowsWithoutValidTimestamp).toBe(1)
  })
})

describe('the ledger cut-over: settlement and order-based figures are separate sections', () => {
  const reliable = SETTLEMENT_LEDGER_RELIABLE_FROM // 2026-09-30
  const range = { startDate: '2026-09-28', endDate: '2026-10-01', timeZone: 'Africa/Windhoek' }
  const b = buildPaymentMethodBreakdown({
    ...range,
    events: [
      ev({ createdAt: '2026-09-29T10:00:00Z', method: 'cash', orderIds: ['pre'] }), // partial day: not a settlement figure
      ev({ createdAt: '2026-09-30T10:00:00Z', method: 'cash', orderIds: ['post'] }),
      gw('2026-10-01T10:00:00Z', 5000, ['post2']),
    ],
    refunds: [],
    paidOrders: [
      order('pre', 'cash', '2026-09-29T10:00:00Z', 3000),
      order('pre2', 'card', '2026-09-28T10:00:00Z', 4000),
      order('post', 'cash', '2026-09-30T10:00:00Z'),
      order('post2', 'card', '2026-10-01T10:00:00Z'),
    ],
  })

  it('the settlement section starts on the reliable day, the order-based one ends the day before', () => {
    expect(reliable).toBe('2026-09-30')
    expect(b.settlement).toMatchObject({ basis: 'settlement_transactions', startDate: '2026-09-30', endDate: '2026-10-01' })
    expect(b.preLedger).toMatchObject({ basis: 'paid_orders', startDate: '2026-09-28', endDate: '2026-09-29' })
  })

  it('the cut-over day is flagged as partial', () => {
    expect(b.cutOverDay).toBe('2026-09-29')
  })

  it('a ledger row on the cut-over day is not a settlement transaction', () => {
    expect(b.settlement!.total.count).toBe(2)
  })

  it('pre-ledger figures count paid ORDERS by order method and are not added to settlement totals', () => {
    expect(b.preLedger!.total).toEqual({ count: 2, amountCents: 7000, ordersCovered: 2 })
    expect(b.preLedger!.denominatorLabel).toMatch(/paid orders \(order-based, not settlement transactions\)/)
    expect(b.settlement!.total.amountCents).toBe(1000 + 5000)
  })

  it('a range wholly before the ledger has no settlement section, and wholly after has no order-based one', () => {
    const before = buildPaymentMethodBreakdown({ startDate: '2026-09-01', endDate: '2026-09-05', ...empty })
    expect(before.settlement).toBeNull()
    expect(before.preLedger).not.toBeNull()
    const after = buildPaymentMethodBreakdown({ startDate: '2026-10-05', endDate: '2026-10-06', ...empty })
    expect(after.preLedger).toBeNull()
    expect(after.cutOverDay).toBeNull()
  })
})

describe('paid orders with no settlement record', () => {
  const day = '2026-10-10T10:00:00Z'

  it('are counted apart, listed by method, and never added to the settlement totals', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      events: [ev({ createdAt: day, orderIds: ['has'] })],
      refunds: [],
      paidOrders: [
        order('has', 'cash', day, 1000),
        order('gap1', 'card', day, 2500),
        order('gap2', 'card', day, 500),
        order('gap3', 'other', day, 100),
      ],
    })
    expect(b.coverage).toMatchObject({
      uncoveredOrders: 3,
      uncoveredAmountCents: 3100,
      firstDay: D,
      lastDay: D,
      byOrderMethod: { card: { orders: 2, amountCents: 3000 }, other: { orders: 1, amountCents: 100 } },
    })
    expect(b.settlement!.total.count).toBe(1)
    expect(b.settlement!.total.amountCents).toBe(1000)
  })

  it('an order proven covered by a direct lookup is not a gap, even if its row is days away', () => {
    const input = { ...base, events: [], refunds: [], paidOrders: [order('late', 'card', day)] }
    expect(buildPaymentMethodBreakdown(input).coverage.uncoveredOrders).toBe(1)
    expect(buildPaymentMethodBreakdown({ ...input, coveredElsewhere: ['late'] }).coverage.uncoveredOrders).toBe(0)
  })

  it('an order whose row is dated outside the range is "settled outside range", not a gap', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      events: [ev({ createdAt: '2026-10-11T10:00:00Z', orderIds: ['next-day'] })],
      refunds: [],
      paidOrders: [order('next-day', 'cash', day)],
    })
    expect(b.coverage).toMatchObject({ uncoveredOrders: 0, settledOutsideRange: 1 })
    expect(b.settlement!.total.count).toBe(0)
  })

  it('a covering row with an unparseable timestamp still proves the order is covered', () => {
    const b = buildPaymentMethodBreakdown({
      ...base,
      events: [ev({ createdAt: 'garbage', orderIds: ['o9'] })],
      refunds: [],
      paidOrders: [order('o9', 'cash', day)],
    })
    expect(b.coverage.uncoveredOrders).toBe(0)
  })

  it('does not report gaps for days that are not settlement-based', () => {
    const b = buildPaymentMethodBreakdown({
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      ...empty,
      paidOrders: [order('old', 'cash', '2026-09-01T10:00:00Z')],
    })
    expect(b.coverage.uncoveredOrders).toBe(0)
    expect(b.preLedger!.total.count).toBe(1)
  })
})

describe('refunds are separate, negative, and outside the percentages', () => {
  const b = buildPaymentMethodBreakdown({
    ...base,
    events: [ev({ createdAt: NOON, method: 'cash', amountCents: 8000 }), gw(NOON, 2000)],
    refunds: [refund(NOON, 3500), refund(NOON, 500), refund('2026-10-11T10:00:00Z', 9999)],
    paidOrders: [],
  })

  it('reports successful refunds as a negative amount and a separate count', () => {
    expect(b.refunds).toEqual({ count: 2, amountCents: -4000, netOfRefundsCents: 6000 })
  })

  it('does not change the transaction count, amounts or percentage denominator', () => {
    expect(b.settlement!.total).toMatchObject({ count: 2, amountCents: 10000 })
    expect(b.settlement!.denominatorLabel).toMatch(/2 successful collection transactions \(refunds excluded\)/)
    expect(rowOf(b, 'cash')!.percentOfCount).toBe(50)
  })

  it('shows refunds on their own day in the daily rows', () => {
    expect(b.settlement!.daily[0].refunds).toEqual({ count: 2, amountCents: -4000 })
  })

  it('ignores refunds outside the requested days', () => {
    expect(b.refunds.count).toBe(2)
  })

  it('reports refunds on pre-ledger days separately rather than dropping them', () => {
    const early = buildPaymentMethodBreakdown({
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      ...empty,
      refunds: [refund('2026-09-01T10:00:00Z', 3500), refund('2026-10-01T10:00:00Z', 1000)],
    })
    expect(early.refundsBeforeLedger).toEqual({ count: 1, amountCents: -3500 })
    expect(early.refunds).toMatchObject({ count: 1, amountCents: -1000 })
  })
})

describe('percentage reconciliation (property)', () => {
  it('always sums to exactly 100.0 for any positive population', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 300; i++) {
      const values = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => Math.floor(rnd() * 5000))
      if (values.every((v) => v === 0)) continue
      const sum = reconcilePercentages(values).reduce((s, p) => s + Math.round(p * 10), 0)
      expect(sum).toBe(1000)
    }
  })

  it('splits an even thirds case without losing a tenth', () => {
    const p = reconcilePercentages([1, 1, 1])
    expect(p.reduce((s, v) => s + Math.round(v * 10), 0)).toBe(1000)
    expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(0.1 + 1e-9)
  })
})
