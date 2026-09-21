/**
 * The READER behind the partial-payment badge: it joins order_lines to their settled allocations
 * and prices each line from `orders.items[source_item_index].total`.
 *
 * Three things are worth pinning here and are not covered by the pure derivation's own tests:
 *
 *   1. a line is priced by its SOURCE INDEX, so a two-line order does not read both lines at the
 *      price of the first;
 *   2. a VOIDED allocation settles nothing, and the query must exclude it rather than the caller;
 *   3. an unreadable read yields NO ENTRY, so the page falls back to its old badge instead of
 *      announcing "UNPAID" about an order that is in fact part-paid.
 *
 * Nothing here settles anything. The module under test issues two SELECTs and returns a label.
 */
import { readOrderPaymentProgress } from '@/lib/payments/read-order-payment-progress'

type LineRow = { id: string; order_id: string; source_item_index: number }
type AllocRow = { order_line_id: string; amount_cents: unknown; settled_at: string | null }

/**
 * A supabase stub that answers the two reads this helper makes.
 *
 * `.is('voided_at', null)` is honoured by the stub ONLY in the sense that it is the terminal call
 * -- the voided rows are simply not in `allocations`, exactly as PostgREST would return them. A
 * stub that returned voided rows anyway would be testing the caller's filtering, which is not
 * where the filter lives.
 */
function db(opts: {
  lines?: LineRow[]
  allocations?: AllocRow[]
  lineError?: string
  allocError?: string
}) {
  return {
    from(table: string) {
      if (table === 'order_lines') {
        return {
          select: () => ({
            in: async () =>
              opts.lineError
                ? { data: null, error: { message: opts.lineError } }
                : { data: opts.lines ?? [], error: null },
          }),
        }
      }
      if (table === 'order_line_allocations') {
        return {
          select: () => ({
            in: () => ({
              is: async () =>
                opts.allocError
                  ? { data: null, error: { message: opts.allocError } }
                  : { data: opts.allocations ?? [], error: null },
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never
}

/** A four-item order of N$40: four N$10 lines. */
const ORDER = {
  id: 'o1',
  total: 40,
  payment_status: 'pending',
  items: [{ total: 10 }, { total: 10 }, { total: 10 }, { total: 10 }],
}

const LINES: LineRow[] = [
  { id: 'l0', order_id: 'o1', source_item_index: 0 },
  { id: 'l1', order_id: 'o1', source_item_index: 1 },
  { id: 'l2', order_id: 'o1', source_item_index: 2 },
  { id: 'l3', order_id: 'o1', source_item_index: 3 },
]

const settled = (lineId: string, cents: number): AllocRow => ({
  order_line_id: lineId,
  amount_cents: cents,
  settled_at: '2026-09-22T10:00:00Z',
})

describe('readOrderPaymentProgress — 0% paid', () => {
  it('reports UNPAID and the whole total remaining when no allocation is settled', async () => {
    const out = await readOrderPaymentProgress(db({ lines: LINES, allocations: [] }), [ORDER])
    const p = out.get('o1')!
    expect(p.state).toBe('unpaid')
    expect(p.paidLines).toBe(0)
    expect(p.totalLines).toBe(4)
    expect(p.remainingCents).toBe(4000)
  })

  it('an UNSETTLED allocation collects nothing', async () => {
    const out = await readOrderPaymentProgress(
      db({
        lines: LINES,
        allocations: [{ order_line_id: 'l0', amount_cents: 1000, settled_at: null }],
      }),
      [ORDER],
    )
    expect(out.get('o1')!.state).toBe('unpaid')
    expect(out.get('o1')!.paidCents).toBe(0)
  })
})

describe('readOrderPaymentProgress — partially paid', () => {
  it('reports 3/4 with N$10 remaining', async () => {
    const out = await readOrderPaymentProgress(
      db({
        lines: LINES,
        allocations: [settled('l0', 1000), settled('l1', 1000), settled('l2', 1000)],
      }),
      [ORDER],
    )
    const p = out.get('o1')!
    expect(p.state).toBe('partial')
    expect(p.paidLines).toBe(3)
    expect(p.totalLines).toBe(4)
    expect(p.remainingCents).toBe(1000)
  })

  it('sums several settled allocations on ONE line before calling it paid', async () => {
    // Two people split one N$10 item; neither share alone covers it.
    const out = await readOrderPaymentProgress(
      db({ lines: LINES, allocations: [settled('l0', 400), settled('l0', 600)] }),
      [ORDER],
    )
    const p = out.get('o1')!
    expect(p.paidLines).toBe(1)
    expect(p.paidCents).toBe(1000)
    expect(p.state).toBe('partial')
  })

  /**
   * THE INDEXING BUG THIS PINS. Priced by position, not by "the first item", so lines of
   * different prices are not all read at the price of items[0].
   */
  it('prices each line by its OWN source_item_index', async () => {
    const mixed = {
      id: 'o2',
      total: 30,
      payment_status: 'pending',
      items: [{ total: 5 }, { total: 25 }],
    }
    const out = await readOrderPaymentProgress(
      db({
        lines: [
          { id: 'm0', order_id: 'o2', source_item_index: 0 },
          { id: 'm1', order_id: 'o2', source_item_index: 1 },
        ],
        // Only the CHEAP line is paid. If both were priced at items[0], this would read as paid.
        allocations: [settled('m0', 500)],
      }),
      [mixed],
    )
    const p = out.get('o2')!
    expect(p.paidLines).toBe(1)
    expect(p.paidCents).toBe(500)
    expect(p.remainingCents).toBe(2500)
    expect(p.state).toBe('partial')
  })

  it('an item with no price leaves its line unpriced and never counts it paid', async () => {
    const unpriced = {
      id: 'o3',
      total: 10,
      payment_status: 'pending',
      items: [{ total: 10 }, {}],
    }
    const out = await readOrderPaymentProgress(
      db({
        lines: [
          { id: 'u0', order_id: 'o3', source_item_index: 0 },
          { id: 'u1', order_id: 'o3', source_item_index: 1 },
        ],
        allocations: [settled('u0', 1000)],
      }),
      [unpriced],
    )
    const p = out.get('o3')!
    expect(p.totalLines).toBe(2)
    expect(p.paidLines).toBe(1)
  })
})

describe('readOrderPaymentProgress — 100% paid', () => {
  it('reports PAID with nothing remaining when every line is settled', async () => {
    const out = await readOrderPaymentProgress(
      db({
        lines: LINES,
        allocations: [settled('l0', 1000), settled('l1', 1000), settled('l2', 1000), settled('l3', 1000)],
      }),
      [ORDER],
    )
    const p = out.get('o1')!
    expect(p.state).toBe('paid')
    expect(p.paidLines).toBe(4)
    expect(p.remainingCents).toBe(0)
  })

  it('an order settled WHOLE reads PAID even with no allocations at all', async () => {
    const out = await readOrderPaymentProgress(db({ lines: LINES, allocations: [] }), [
      { ...ORDER, payment_status: 'paid' },
    ])
    const p = out.get('o1')!
    expect(p.state).toBe('paid')
    expect(p.remainingCents).toBe(0)
    expect(p.paidCents).toBe(4000)
  })
})

describe('readOrderPaymentProgress — degrades to SILENCE, never to a wrong figure', () => {
  it('yields no entry when the lines cannot be read', async () => {
    const out = await readOrderPaymentProgress(db({ lineError: 'boom' }), [ORDER])
    expect(out.has('o1')).toBe(false)
  })

  it('yields no entry when the allocations cannot be read', async () => {
    const out = await readOrderPaymentProgress(db({ lines: LINES, allocError: 'boom' }), [ORDER])
    // The alternative -- reporting UNPAID for a part-paid order -- is the failure this avoids.
    expect(out.has('o1')).toBe(false)
  })

  it('asks the database nothing when there are no orders', async () => {
    const out = await readOrderPaymentProgress(
      db({ lineError: 'must not be reached' }),
      [],
    )
    expect(out.size).toBe(0)
  })
})
