/**
 * THE FINANCIAL PROJECTION IS NET OF REFUNDS (Sprint 2026-09-29 brief, team-lead ruling).
 *
 * `paid` ignored refunds, so a card sale refunded in full and then cancelled read as live 0,
 * paid N -> overpaid N: "owed back" for money already returned, which invites a second refund.
 * The source is the payment projection's own: payment_events sale + refund_succeeded rows.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'
import {
  FinancialsUnreadable,
  computeOrderFinancials,
  loadOrderFinancials,
  loadTabFinancials,
  projectOrderWithInputs,
  projectTabWithInputs,
  readProjectionInputs,
  type FinancialOrderInput,
} from '@/lib/orders/order-financials'
import { attachGuestFinancials } from '@/lib/guest-orders/guest-financials'
import { computeTabFigures } from '@/lib/tabs/tab-outstanding'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000061'

let db: InMemoryDb

function seed(orderOverrides: Array<Record<string, unknown>>) {
  const f = new AmendFixture(TAB)
  const ids = orderOverrides.map((o, i) =>
    f.place([{ name: `Dish ${i}`, quantity: 1, total: i === 0 ? 220 : 500 }], {
      payment_status: 'paid',
      status: 'completed',
      ...o,
    } as never).id,
  )
  db = new InMemoryDb({
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    payment_events: [],
  })
  return ids
}

const sale = (orderIds: string[], amount: number, no = 'FT-S-1') => ({
  id: `sale-${no}`, restaurant_id: RESTAURANT, event_type: 'sale', business_order_no: no,
  origin_business_order_no: no, amount, order_ids: orderIds, created_at: '2026-09-29T10:00:00Z',
})
const refund = (amount: number, n: number, origin = 'FT-S-1') => ({
  id: `refund-${n}`, restaurant_id: RESTAURANT, event_type: 'refund_succeeded', business_order_no: `FT-R-${n}`,
  origin_business_order_no: origin, amount, order_ids: [], created_at: '2026-09-29T11:00:00Z',
})

const load = async (id: string) =>
  (await loadOrderFinancials(db.client(), RESTAURANT, [id])).byId.get(id)!

describe('order financials net of refunds', () => {
  it('no refund: unchanged (paid = the settled charge, refunded 0)', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }])
    db.rows('payment_events').push(sale([a], 220))
    const f = await load(a)
    expect(f).toMatchObject({ paidCents: 22000, refundedCents: 0, overpaidCents: 0, outstandingCents: 0 })
  })

  it('a REFUNDED order: paid 0, refunded the whole charge, nothing overpaid or owed', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    const f = await load(a)
    expect(f).toMatchObject({ paidCents: 0, refundedCents: 22000, overpaidCents: 0, outstandingCents: 0 })
  })

  it('a PARTIALLY refunded order: paid is what the venue still holds', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }])
    db.rows('payment_events').push(sale([a], 220), refund(50, 1), refund(50, 2))
    const f = await load(a)
    expect(f).toMatchObject({ paidCents: 12000, refundedCents: 10000, overpaidCents: 0 })
  })

  it('REFUNDED THEN CANCELLED: overpaid 0 -- no second refund is invited', async () => {
    const [a] = seed([{ settled_charge_cents: 22000, status: 'cancelled' }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    const f = await load(a)
    expect(f).toMatchObject({ liveCents: 0, paidCents: 0, refundedCents: 22000, overpaidCents: 0 })
  })

  it('a refunded LEGACY order (no recorded charge) refunds its whole paid total', async () => {
    const [a] = seed([{ settled_charge_cents: null, status: 'cancelled' }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    expect((await load(a)).overpaidCents).toBe(0)
  })

  it('a tipped sale refunded in full (bill + tip) refunds the bill in full, never below zero', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }])
    db.rows('payment_events').push(sale([a], 242), refund(242, 1))
    expect(await load(a)).toMatchObject({ paidCents: 0, refundedCents: 22000 })
  })

  it('a multi-order tab sale refunded in full: every covered order, and the tab, net to zero', async () => {
    const [a, b] = seed([{ settled_charge_cents: 22000 }, { settled_charge_cents: 50000, status: 'cancelled' }])
    db.rows('payment_events').push(sale([a, b], 720), refund(720, 1))
    const tab = await loadTabFinancials(db.client(), RESTAURANT, TAB)
    expect(tab).toMatchObject({ paidCents: 0, refundedCents: 72000, overpaidCents: 0, outstandingCents: 0 })
  })

  it('a multi-order sale refunded in part: proportional, and the tab sum is exact', async () => {
    const [a, b] = seed([{ settled_charge_cents: 22000 }, { settled_charge_cents: 50000 }])
    db.rows('payment_events').push(sale([a, b], 720), refund(360, 1))
    const tab = await loadTabFinancials(db.client(), RESTAURANT, TAB)
    expect(tab.orders.map((o) => o.refundedCents)).toEqual([11000, 25000])
    expect(tab.refundedCents).toBe(36000)
    expect(tab.paidCents).toBe(36000)
  })

  it('an UNPAID order is never asked about refunds (no read that could not find one)', async () => {
    const [a] = seed([{ payment_status: 'pending', status: 'preparing' }])
    const client = db.client()
    const spy = jest.spyOn(client, 'from')
    await loadOrderFinancials(client, RESTAURANT, [a])
    expect(spy.mock.calls.map((c) => c[0])).not.toContain('payment_events')
  })

  it('FAILS CLOSED: an unreadable refund ledger throws FinancialsUnreadable', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }])
    const client = db.client()
    const real = client.from.bind(client)
    client.from = ((table: string) => {
      const b = real(table) as unknown as Record<string, unknown>
      if (table === 'payment_events') {
        b.then = ((ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: 'down (test)' } }).then(ok)) as never
      }
      return b as never
    }) as never
    await expect(loadOrderFinancials(client, RESTAURANT, [a])).rejects.toBeInstanceOf(FinancialsUnreadable)
  })

  it('the pure function: a fraction applies to the gross paid figure', () => {
    const f = computeOrderFinancials(
      { id: 'o', total: 100, items: [], payment_status: 'paid', settled_charge_cents: 10000 },
      [],
      0,
      0.25,
    )
    expect(f).toMatchObject({ paidCents: 7500, refundedCents: 2500 })
  })
})

/**
 * THE ROUTES THAT KEEP THEIR OWN ORDER READ (order history, the terminal tables view, guest
 * financials, tab-outstanding) go through the same readProjectionInputs -> project*WithInputs path
 * as the loaders, so refunds cannot be applied on one and forgotten on another (Sprint 2026-09-29).
 */
describe('callers of readProjectionInputs are net of refunds too', () => {
  it('readProjectionInputs + projectOrderWithInputs: a refunded order is paid 0', async () => {
    const [a] = seed([{ settled_charge_cents: 22000, status: 'cancelled' }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    const rows = db.rows('orders') as unknown as FinancialOrderInput[]
    const inputs = await readProjectionInputs(db.client(), rows)
    expect(projectOrderWithInputs(rows[0], inputs)).toMatchObject({ paidCents: 0, refundedCents: 22000, overpaidCents: 0 })
  })

  it('projectTabWithInputs: the tab view sums the refunded figures', async () => {
    const [a, b] = seed([{ settled_charge_cents: 22000 }, { settled_charge_cents: 50000 }])
    db.rows('payment_events').push(sale([a, b], 720), refund(720, 1))
    const rows = db.rows('orders') as unknown as FinancialOrderInput[]
    const tab = projectTabWithInputs(rows, await readProjectionInputs(db.client(), rows))
    expect(tab).toMatchObject({ paidCents: 0, refundedCents: 72000, overpaidCents: 0 })
  })

  it('guest financials: a refunded-then-cancelled order is not shown as overpaid to the customer', async () => {
    const [a] = seed([{ settled_charge_cents: 22000, status: 'cancelled' }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    const [out] = await attachGuestFinancials(db.client() as never, db.rows('orders').map((o) => ({ ...o })))
    expect(out.financials).toMatchObject({ paid_cents: 0, overpaid_cents: 0, live_cents: 0 })
  })

  it('tab-outstanding: a refund changes what was paid, never what is owed', async () => {
    const [a] = seed([{ settled_charge_cents: 22000 }, { payment_status: 'pending', status: 'preparing' }])
    db.rows('payment_events').push(sale([a], 220), refund(220, 1))
    const rows = db.rows('orders') as unknown as FinancialOrderInput[]
    const inputs = await readProjectionInputs(db.client(), rows)
    expect(computeTabFigures(rows as never, [], inputs).payable).toBe(500)
  })
})
