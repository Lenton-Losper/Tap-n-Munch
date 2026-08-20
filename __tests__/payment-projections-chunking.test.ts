/**
 * #322 -- CHUNKING MUST NOT CHANGE THE ANSWER.
 *
 * getPaymentProjections now splits its id lists across several requests, because `.overlaps()` and
 * `.in()` spell every id into the request URI and the upstream answers 400 past roughly 24 KB --
 * measured on staging: 620 paid orders in the window returned 200, 640 returned a zero-length 500.
 *
 * The risk the split introduces is ORDERING. "Newest sale wins" was previously guaranteed by a
 * single `.order('created_at', desc)` over the whole result. Per-batch ordering does not give that:
 * if an OLDER sale for an order arrives in an earlier batch and a NEWER one in a later batch, a
 * naive merge keeps the older row and every downstream amount is wrong.
 *
 * The live probe could not cover this. Staging has 21 payment_events but none of them overlap the
 * orders on the pages compared, so the projection path returns early there -- byte-identical
 * responses proved the chunking did not break the EMPTY case and nothing more. This covers the
 * case that actually carries money.
 */
export {} // module scope

import { getPaymentProjections } from '@/lib/payments/get-payment-projection'

const RESTAURANT = '01bf27f1-a958-4322-bb3e-cc5240987808'

type SaleRow = {
  business_order_no: string
  amount: number
  currency: string
  order_ids: string[]
  created_at: string
}
type RefundRow = { amount: number; origin_business_order_no: string }

/** Records every batch the caller sends, so the test can assert the split really happened. */
type Recorder = { overlapsBatches: string[][]; inBatches: string[][] }

function makeClient(sales: SaleRow[], refunds: RefundRow[], rec: Recorder) {
  return {
    from(table: string) {
      let kind: 'sale' | 'refund' = 'sale'
      let batch: string[] = []

      const builder: Record<string, unknown> = {}
      const self = () => builder

      builder.select = self
      builder.eq = (col: string, val: string) => {
        if (col === 'event_type') kind = val === 'sale' ? 'sale' : 'refund'
        return builder
      }
      builder.overlaps = (_col: string, ids: string[]) => {
        rec.overlapsBatches.push([...ids])
        batch = ids
        return builder
      }
      builder.in = (_col: string, nos: string[]) => {
        rec.inBatches.push([...nos])
        // Terminal for the refund query.
        return Promise.resolve({
          data: refunds.filter((r) => nos.includes(r.origin_business_order_no)),
          error: null,
        })
      }
      builder.order = () => {
        // Terminal for the sales query: only rows overlapping THIS batch, ordered desc within it.
        const rows = sales
          .filter((s) => s.order_ids.some((id) => batch.includes(id)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
        return Promise.resolve({ data: rows, error: null })
      }
      void table
      void kind
      return builder
    },
  } as never
}

function ids(n: number, prefix = 'o'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`)
}

describe('the split happens at all', () => {
  it('sends more than one batch once the id list is large', async () => {
    const rec: Recorder = { overlapsBatches: [], inBatches: [] }
    const orderIds = ids(650)
    await getPaymentProjections(makeClient([], [], rec), RESTAURANT, orderIds)

    expect(rec.overlapsBatches.length).toBeGreaterThan(1)
    // No single request may carry the whole list -- that is the shape that returned 400.
    for (const b of rec.overlapsBatches) expect(b.length).toBeLessThanOrEqual(200)
    // Every id is still asked about exactly once.
    expect(rec.overlapsBatches.flat().sort()).toEqual([...orderIds].sort())
  })

  it('sends a single batch for a small list, unchanged from before', async () => {
    const rec: Recorder = { overlapsBatches: [], inBatches: [] }
    await getPaymentProjections(makeClient([], [], rec), RESTAURANT, ids(20))
    expect(rec.overlapsBatches.length).toBe(1)
  })
})

describe('NEWEST SALE STILL WINS ACROSS BATCH BOUNDARIES', () => {
  /**
   * The hazard needs a BRIDGING sale, and my first attempt at this test did not build one --
   * it passed with the re-sort deleted, which is the only reason the flaw was found.
   *
   * A sale naming only `target` always comes back in target's own batch, already ordered, so
   * there is no cross-batch race. The race needs a sale whose order_ids SPAN two batches
   * (one payment_event can cover many orders):
   *
   *   OLD = {bridge, target}   bridge is in batch 1, so OLD is returned while processing batch 1
   *   NEW = {target}           returned only when batch 2 is processed
   *
   * Batch 1 therefore assigns target -> OLD before batch 2 is even queried, and "first assignment
   * wins" then refuses the newer row. Only a re-sort over the whole collected set fixes it.
   */
  it('prefers the newer sale when an older BRIDGING sale arrived in an earlier batch', async () => {
    const orderIds = ids(400) // two batches: [0..199], [200..399]
    const bridge = orderIds[0] // batch 1
    const target = orderIds[399] // batch 2

    const sales: SaleRow[] = [
      {
        business_order_no: 'OLD',
        amount: 10,
        currency: 'NAD',
        order_ids: [bridge, target], // spans both batches -> returned during batch 1
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        business_order_no: 'NEW',
        amount: 99,
        currency: 'NAD',
        order_ids: [target], // only reachable in batch 2
        created_at: '2026-08-20T00:00:00Z',
      },
    ]

    const rec: Recorder = { overlapsBatches: [], inBatches: [] }
    const result = await getPaymentProjections(makeClient(sales, [], rec), RESTAURANT, orderIds)

    expect(rec.overlapsBatches.length).toBe(2)
    expect(result.get(target)?.originBusinessOrderNo).toBe('NEW')
    expect(result.get(target)?.originalAmount).toBe(99)
    // The bridging order itself still resolves to its only sale.
    expect(result.get(bridge)?.originBusinessOrderNo).toBe('OLD')
  })

  it('is unaffected when the newest sale is already in the first batch', async () => {
    const orderIds = ids(400)
    const target = orderIds[0]
    const sales: SaleRow[] = [
      { business_order_no: 'NEW', amount: 99, currency: 'NAD', order_ids: [target], created_at: '2026-08-20T00:00:00Z' },
      { business_order_no: 'OLD', amount: 10, currency: 'NAD', order_ids: [target], created_at: '2026-08-01T00:00:00Z' },
    ]
    const rec: Recorder = { overlapsBatches: [], inBatches: [] }
    const result = await getPaymentProjections(makeClient(sales, [], rec), RESTAURANT, orderIds)
    expect(result.get(target)?.originBusinessOrderNo).toBe('NEW')
  })
})

describe('refund lookups are split too, and still total correctly', () => {
  it('sums refunds for origins spread across more than one batch', async () => {
    // 300 orders, each with its own sale -> 300 distinct origins -> two `.in()` batches.
    const orderIds = ids(300)
    const sales: SaleRow[] = orderIds.map((id, i) => ({
      business_order_no: `BO${i}`,
      amount: 100,
      currency: 'NAD',
      order_ids: [id],
      created_at: '2026-08-10T00:00:00Z',
    }))
    // A refund against an origin that lands in the SECOND batch of origins.
    const refunds: RefundRow[] = [
      { amount: 25, origin_business_order_no: 'BO250' },
      { amount: 15, origin_business_order_no: 'BO250' },
    ]

    const rec: Recorder = { overlapsBatches: [], inBatches: [] }
    const result = await getPaymentProjections(makeClient(sales, refunds, rec), RESTAURANT, orderIds)

    expect(rec.inBatches.length).toBeGreaterThan(1)
    // Both refund rows for that origin must be counted, from whichever batch they came back in.
    expect(result.get(orderIds[250])?.refundedAmount).toBe(40)
    // An untouched order keeps a zero refund.
    expect(result.get(orderIds[0])?.refundedAmount).toBe(0)
  })
})
