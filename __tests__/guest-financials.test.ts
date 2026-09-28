/**
 * The customer's own order after staff voids (Sprint 2026-09-28): what the guest routes attach, and
 * the words the screens render.
 */
import { attachGuestFinancials } from '@/lib/guest-orders/guest-financials'
import { displayOrderTotal, voidedTotalsLabel } from '@/lib/orders/voided-totals-label'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'

function rivieraRows() {
  const f = new AmendFixture('t')
  const o = f.place(RIVIERA_ITEMS, { id: '0000aaaa-0000-4000-8000-000000000160' })
  f.amend(o.id, 'Wish You Were Here', 1)
  f.amend(o.id, 'Double Cheese Burger', 1)
  f.amend(o.id, 'Seared Salmon', 1)
  const db = new InMemoryDb({
    order_lines: f.lines.map((l) => ({ ...l })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
  return { f, o, db }
}

describe('attachGuestFinancials', () => {
  it('RIVIERA: the order reads N$465 live, keeps its N$1,945 total, and marks the voided lines', async () => {
    const { f, o, db } = rivieraRows()
    const [row] = await attachGuestFinancials(db.client(), [{ ...f.orders[0], surface: 'orders' }])
    expect(row.total).toBe(1945)
    expect(row.live_total).toBe(465)
    expect((row.financials as Record<string, number>).voided_cents).toBe(148000)
    const voided = (row.items as Array<Record<string, unknown>>).filter((i) => i.voided === true).map((i) => i.name)
    expect(voided.sort()).toEqual(['Double Cheese Burger', 'Seared Salmon', 'Wish You Were Here'])
    expect(voidedTotalsLabel(row)).toBe('N$1945.00 original · N$465.00 after voids')
    expect(displayOrderTotal(row)).toBe(465)
    void o
  })

  it('leaves an order_request untouched (it cannot have been amended)', async () => {
    const { db } = rivieraRows()
    const request = { id: 'req-1', surface: 'order_requests', total: 50, items: [{ name: 'x', total: 50 }] }
    const [row] = await attachGuestFinancials(db.client(), [request])
    expect(row).toBe(request)
  })

  it('an unamended order gets no "after voids" label and shows its total', async () => {
    const f = new AmendFixture('t')
    f.place([{ name: 'A', quantity: 1, total: 80 }])
    const db = new InMemoryDb({ order_lines: f.lines, order_line_allocations: [], order_line_allocation_settlements: [] })
    const [row] = await attachGuestFinancials(db.client(), [{ ...f.orders[0] }])
    expect(row.live_total).toBe(80)
    expect(voidedTotalsLabel(row)).toBeNull()
    expect(displayOrderTotal(row)).toBe(80)
  })

  it('DEGRADES VISIBLY: an unreadable projection leaves the rows as stored', async () => {
    const { f } = rivieraRows()
    const broken = {
      from: () => {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          in: () => b,
          is: () => b,
          order: () => b,
          range: async () => ({ data: null, error: { message: 'down' } }),
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'down' } }).then(r),
        })
        return b
      },
    }
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const input = [{ ...f.orders[0] }]
    const out = await attachGuestFinancials(broken, input)
    expect(out).toBe(input)
    expect(displayOrderTotal(out[0])).toBe(1945)
    expect(voidedTotalsLabel(out[0])).toBeNull()
  })
})
