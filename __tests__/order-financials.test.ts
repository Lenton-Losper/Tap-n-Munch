/**
 * THE FINANCIAL PROJECTION (lib/orders/order-financials.ts), pinned case by case.
 *
 * The Riviera #160 walk-through at the bottom is a PERMANENT REGRESSION. Its figures are the real
 * order's; every intermediate state after each amendment is asserted, for the order and for the tab,
 * because the defect it guards against (the tab reading the original PLUS every replacement) only
 * appears once replacements exist.
 */
import {
  computeOrderFinancials,
  computeTabFinancials,
  FinancialsUnreadable,
  FINANCIAL_ORDER_COLUMNS,
  isVoidedLine,
  loadOrderFinancials,
  loadTabFinancials,
  readFinancialLines,
} from '@/lib/orders/order-financials'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'
import { InMemoryDb } from './helpers/in-memory-postgrest'

const N = (major: number) => Math.round(major * 100)

function orderOf(f: AmendFixture, id: string) {
  const o = f.orders.find((x) => x.id === id)!
  return computeOrderFinancials(o, f.lines)
}

function tabOf(f: AmendFixture, settled: Map<string, number> = new Map()) {
  return computeTabFinancials(f.orders, f.lines, settled)
}

describe('VOIDED_LINE', () => {
  it('is voided only when EVERY owning station is voided', () => {
    expect(isVoidedLine({ kitchen_state: 'voided', bar_state: null })).toBe(true)
    expect(isVoidedLine({ kitchen_state: 'voided', bar_state: 'voided' })).toBe(true)
    // A half-voided 'both' line is still live.
    expect(isVoidedLine({ kitchen_state: 'voided', bar_state: 'outstanding' })).toBe(false)
    // A line with no owning station is not voided (and not anything else).
    expect(isVoidedLine({ kitchen_state: null, bar_state: null })).toBe(false)
  })
})

describe('computeOrderFinancials', () => {
  it('an unamended, unpaid order: live = original = outstanding', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 50 }, { name: 'B', quantity: 2, total: 30 }])
    const fin = orderOf(f, o.id)
    expect(fin).toMatchObject({
      originalCents: 8000,
      voidedCents: 0,
      liveCents: 8000,
      paidCents: 0,
      outstandingCents: 8000,
      overpaidCents: 0,
      lineCoverage: 'full',
    })
  })

  it('a single partial reduction voids the WHOLE original line; the replacement carries the rest', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'Steak', quantity: 2, total: 400 }, { name: 'Wine', quantity: 1, total: 100 }])
    const r = f.amend(o.id, 'Steak', 1)!
    expect(orderOf(f, o.id)).toMatchObject({ originalCents: N(500), voidedCents: N(400), liveCents: N(100) })
    expect(orderOf(f, r.id)).toMatchObject({ originalCents: N(200), voidedCents: 0, liveCents: N(200) })
    // Nothing counted twice: 100 + 200 = 300, the real bill.
    expect(tabOf(f).liveCents).toBe(N(300))
  })

  it('multiple reductions on one order', () => {
    const f = new AmendFixture()
    const o = f.place([
      { name: 'A', quantity: 3, total: 300 },
      { name: 'B', quantity: 2, total: 100 },
      { name: 'C', quantity: 1, total: 20 },
    ])
    f.amend(o.id, 'A', 1)
    f.amend(o.id, 'B', 1)
    expect(orderOf(f, o.id)).toMatchObject({ voidedCents: N(400), liveCents: N(20) })
    expect(tabOf(f)).toMatchObject({ liveCents: N(20 + 100 + 50), originalCents: N(420 + 100 + 50) })
  })

  it('a full void of one line (no replacement order)', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 60 }, { name: 'B', quantity: 1, total: 40 }])
    expect(f.amend(o.id, 'A', 0)).toBeNull()
    expect(orderOf(f, o.id)).toMatchObject({ voidedCents: N(60), liveCents: N(40), outstandingCents: N(40) })
    expect(f.orders).toHaveLength(1)
  })

  it('every line of an order voided: live and outstanding are 0 while the stored total is not', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 60 }, { name: 'B', quantity: 2, total: 40, route: 'both' }])
    f.amend(o.id, 'A', 0)
    f.amend(o.id, 'B', 0)
    const fin = orderOf(f, o.id)
    expect(fin).toMatchObject({ originalCents: N(100), voidedCents: N(100), liveCents: 0, outstandingCents: 0 })
    // The order is still `pending` -- the projection, not the status, is what says nothing is owed.
    expect(f.orders[0].payment_status).toBe('pending')
    expect(tabOf(f).outstandingCents).toBe(0)
  })

  it('an order amended across several rounds, including a replacement that is itself reduced', () => {
    const f = new AmendFixture()
    const round1 = f.place([{ name: 'Wings', quantity: 4, total: 200 }])
    const round2 = f.place([{ name: 'Beer', quantity: 3, total: 90, route: 'bar' }])
    const r1 = f.amend(round1.id, 'Wings', 3)! // 150 survives on r1
    const r2 = f.amend(r1.id, 'Wings', 1)! //      50 survives on r2, r1 fully voided
    f.amend(round2.id, 'Beer', 2) //               60 survives
    expect(orderOf(f, r1.id)).toMatchObject({ originalCents: N(150), liveCents: 0 })
    expect(orderOf(f, r2.id)).toMatchObject({ originalCents: N(50), liveCents: N(50) })
    const tab = tabOf(f)
    expect(tab.liveCents).toBe(N(50 + 60))
    expect(tab.originalCents).toBe(N(200 + 90 + 150 + 50 + 60))
    expect(tab.outstandingCents).toBe(N(110))
  })

  it('a cancelled order owes nothing and is live 0, whatever its lines say', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 70 }], { status: 'cancelled', payment_status: 'cancelled' })
    expect(orderOf(f, o.id)).toMatchObject({ originalCents: N(70), liveCents: 0, outstandingCents: 0, cancelled: true })
  })

  it('a LEGACY paid order (no recorded charge) that was later amended shows the overpayment', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 2, total: 100 }, { name: 'B', quantity: 1, total: 50 }], {
      payment_status: 'paid',
      status: 'completed',
    })
    f.amend(o.id, 'A', 0)
    const fin = orderOf(f, o.id)
    expect(fin).toMatchObject({
      paidBasis: 'legacy_total',
      liveCents: N(50),
      paidCents: N(150),
      outstandingCents: 0,
      overpaidCents: N(100),
    })
  })

  it('a paid order with a RECORDED charge uses what was actually taken', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 2, total: 100 }, { name: 'B', quantity: 1, total: 50 }], {
      payment_status: 'paid',
      settled_charge_cents: N(50),
    })
    f.amend(o.id, 'A', 0)
    expect(orderOf(f, o.id)).toMatchObject({ paidBasis: 'recorded_charge', paidCents: N(50), overpaidCents: 0 })
  })

  it('allocation settlements reduce what is outstanding and add to paid', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 17 }, { name: 'B', quantity: 1, total: 20 }])
    const fin = computeOrderFinancials(o, f.lines, N(17))
    expect(fin).toMatchObject({ paidCents: N(17), outstandingCents: N(20), paidBasis: 'allocations' })
  })

  it('an order with no order_lines coverage cannot have a voided line: it owes its stored total', () => {
    const f = new AmendFixture()
    const o = f.place([{ name: 'A', quantity: 1, total: 99 }])
    const fin = computeOrderFinancials(o, [])
    expect(fin).toMatchObject({ lineCoverage: 'none', liveCents: N(99), outstandingCents: N(99) })
  })

  it('a settlement artefact is excluded from every tab sum', () => {
    const f = new AmendFixture()
    f.place([{ name: 'A', quantity: 1, total: 40 }])
    f.place([{ name: 'Tab settlement', quantity: 1, total: 40 }], { tab_settlement_for_tab_id: 'tab-1' })
    const tab = tabOf(f)
    expect(tab.orders).toHaveLength(1)
    expect(tab.liveCents).toBe(N(40))
    expect(tab.originalCents).toBe(N(40))
  })
})

describe('RIVIERA #160 -- permanent regression', () => {
  function riviera() {
    const f = new AmendFixture('riviera-table-1')
    const order = f.place(RIVIERA_ITEMS, { id: 'riviera-160' })
    return { f, order }
  }

  it('as placed: N$1,945, nothing voided, all of it outstanding', () => {
    const { f, order } = riviera()
    expect(orderOf(f, order.id)).toMatchObject({
      originalCents: N(1945),
      voidedCents: 0,
      liveCents: N(1945),
      outstandingCents: N(1945),
    })
    expect(tabOf(f).liveCents).toBe(N(1945))
  })

  it('every intermediate figure through the three reductions, for the order and the tab', () => {
    const { f, order } = riviera()

    // 1. Wish You Were Here 2 -> 1: N$380 line voided, N$190 replacement.
    const r1 = f.amend(order.id, 'Wish You Were Here', 1)!
    expect(orderOf(f, r1.id)).toMatchObject({ originalCents: N(190), liveCents: N(190) })
    expect(orderOf(f, order.id)).toMatchObject({
      originalCents: N(1945),
      voidedCents: N(380),
      liveCents: N(1565),
      outstandingCents: N(1565),
    })
    let tab = tabOf(f)
    expect(tab).toMatchObject({ originalCents: N(2135), voidedCents: N(380), liveCents: N(1755), outstandingCents: N(1755) })

    // 2. Double Cheese Burger 2 -> 1: N$180 voided, N$90 replacement.
    const r2 = f.amend(order.id, 'Double Cheese Burger', 1)!
    expect(orderOf(f, r2.id)).toMatchObject({ originalCents: N(90), liveCents: N(90) })
    expect(orderOf(f, order.id)).toMatchObject({ voidedCents: N(560), liveCents: N(1385), outstandingCents: N(1385) })
    tab = tabOf(f)
    expect(tab).toMatchObject({ originalCents: N(2225), voidedCents: N(560), liveCents: N(1665), outstandingCents: N(1665) })

    // 3. Seared Salmon 2 -> 1: N$920 voided, N$460 replacement.
    const r3 = f.amend(order.id, 'Seared Salmon', 1)!
    expect(orderOf(f, r3.id)).toMatchObject({ originalCents: N(460), liveCents: N(460) })
    expect(orderOf(f, order.id)).toMatchObject({
      originalCents: N(1945),
      voidedCents: N(1480),
      liveCents: N(465),
      outstandingCents: N(465),
    })
    tab = tabOf(f)
    expect(tab).toMatchObject({
      originalCents: N(1945 + 190 + 90 + 460),
      voidedCents: N(1480),
      liveCents: N(1205),
      outstandingCents: N(1205),
      overpaidCents: 0,
    })

    // THE DEFECT: the tab must never read as the original plus every replacement.
    expect(tab.liveCents).not.toBe(N(1945 + 190 + 90 + 460))
    expect(tab.outstandingCents).not.toBe(N(1945 + 190 + 90 + 460))
    // Nor as the original alone.
    expect(tab.liveCents).not.toBe(N(1945))
  })

  function afterThreeReductions() {
    const r = riviera()
    r.f.amend(r.order.id, 'Wish You Were Here', 1)
    r.f.amend(r.order.id, 'Double Cheese Burger', 1)
    r.f.amend(r.order.id, 'Seared Salmon', 1)
    return r
  }

  it('Modena CANCELLED (void applied): the order and the tab each drop by exactly N$240', () => {
    const { f, order } = afterThreeReductions()
    expect(f.amend(order.id, 'Modena Pasta', 0)).toBeNull()
    expect(orderOf(f, order.id)).toMatchObject({ voidedCents: N(1720), liveCents: N(225), outstandingCents: N(225) })
    expect(tabOf(f)).toMatchObject({ liveCents: N(965), outstandingCents: N(965) })
  })

  it('Modena REFUSED (window closed): nothing moves', () => {
    const { f, order } = afterThreeReductions()
    f.markReady(order.id, 'Modena Pasta')
    f.refuse(order.id, 'Modena Pasta')
    expect(orderOf(f, order.id)).toMatchObject({ voidedCents: N(1480), liveCents: N(465), outstandingCents: N(465) })
    expect(tabOf(f)).toMatchObject({ liveCents: N(1205), outstandingCents: N(1205) })
  })
})

describe('the readers', () => {
  function seededDb() {
    const f = new AmendFixture('tab-r')
    const o = f.place([{ name: 'A', quantity: 2, total: 100 }, { name: 'B', quantity: 1, total: 30 }])
    f.amend(o.id, 'A', 1)
    const db = new InMemoryDb({
      orders: f.orders.map((x) => ({ ...x, restaurant_id: 'rest-1' })),
      order_lines: f.lines.map((l) => ({ ...l })),
      order_line_allocations: [],
      order_line_allocation_settlements: [],
    })
    return { f, o, db }
  }

  it('loadTabFinancials reads orders, lines and the ledger and projects them', async () => {
    const { db } = seededDb()
    const tab = await loadTabFinancials(db.client(), 'rest-1', 'tab-r')
    expect(tab.liveCents).toBe(N(30 + 50))
    expect(tab.originalCents).toBe(N(130 + 50))
  })

  it('loadOrderFinancials is scoped to the restaurant', async () => {
    const { db, o } = seededDb()
    const mine = await loadOrderFinancials(db.client(), 'rest-1', [o.id])
    expect(mine.byId.get(o.id)?.liveCents).toBe(N(30))
    const theirs = await loadOrderFinancials(db.client(), 'rest-2', [o.id])
    expect(theirs.rows).toHaveLength(0)
  })

  it('selects settled_charge_cents (a written column that is not selected is inert)', () => {
    expect(FINANCIAL_ORDER_COLUMNS.split(',').map((c) => c.trim())).toEqual(
      expect.arrayContaining(['id', 'total', 'items', 'status', 'payment_status', 'tab_settlement_for_tab_id', 'settled_charge_cents']),
    )
  })

  it('FAILS CLOSED: a failed line read throws rather than reading as "nothing voided"', async () => {
    const failing = {
      from: () => ({
        select() { return this },
        in() { return this },
        order() { return this },
        range: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    }
    await expect(readFinancialLines(failing, ['o1'])).rejects.toBeInstanceOf(FinancialsUnreadable)
  })

  it('FAILS CLOSED: a failed settlement read throws rather than reading as "nothing paid"', async () => {
    const { db, o } = seededDb()
    const client = db.client()
    const wrapped = {
      from(table: string) {
        if (table === 'order_line_allocations') {
          return {
            select() { return this },
            in() { return this },
            is: async () => ({ data: null, error: { message: 'allocations down' } }),
          }
        }
        return client.from(table)
      },
    }
    await expect(loadOrderFinancials(wrapped, 'rest-1', [o.id])).rejects.toBeInstanceOf(FinancialsUnreadable)
  })
})
