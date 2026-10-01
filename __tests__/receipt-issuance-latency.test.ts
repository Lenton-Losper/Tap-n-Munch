/**
 * issueReceiptForOrder -- round trips, and that every outcome is unchanged (perf/latency-sprint
 * 2026-10-01, Phase 4).
 *
 * Every paid path awaits a receipt before it answers: the terminal payment callback, verify-payment,
 * the webhook, reconcile, both settle routes. Receipts must NOT move behind the response -- issuance
 * is silent (no retry, nobody emailed: memory #234), so a dropped background issuance is a lost tax
 * document. What CAN change is how long it takes: after the order is read, the restaurant, the two
 * billing-profile reads, the sale events and the tip depend only on the order, and were one after
 * another.
 *
 * Runs the REAL issuer against the in-memory store; every query costs DELAY_MS and is recorded.
 */
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

const DELAY_MS = 8
const RESTAURANT = testUuid('rest')
const ORDER = testUuid('ord')

type Trip = { table: string; select: string; kind: 'read' | 'write' | 'rpc'; start: number; end: number }
let mockDb: InMemoryDb
let mockTrips: Trip[] = []
/** A READ of `table` whose select list contains `select` answers with an error instead of rows. */
let mockFail: Array<{ table: string; select?: string; throws?: boolean; late?: boolean }> = []

async function mockTrip<T>(trip: Omit<Trip, 'start' | 'end'>, then: () => T): Promise<T> {
  const start = performance.now()
  await new Promise((r) => setTimeout(r, DELAY_MS))
  mockTrips.push({ ...trip, start, end: performance.now() })
  return then()
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from(table: string) {
        return mockRecorded(real.from(table), { table, select: '', kind: 'read' })
      },
      rpc(name: string, args: unknown) {
        return mockTrip({ table: `rpc:${name}`, select: '', kind: 'rpc' }, () => real.rpc(name, args))
      },
    }
  },
}))

function mockRecorded(target: any, state: { table: string; select: string; kind: Trip['kind'] }): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok?: (v: any) => unknown, err?: (e: unknown) => unknown) =>
          mockTrip({ ...state }, () => {
            const failing =
              state.kind === 'read' &&
              mockFail.some((f) => f.table === state.table && (!f.select || state.select.includes(f.select)))
            return failing
              ? Promise.resolve({ data: null, error: { message: `${state.table} read refused (test)` } }).then(ok, err)
              : t.then(ok, err)
          })
      }
      const value = t[prop]
      if (typeof value !== 'function') return value
      // The fake's single()/maybeSingle() are async methods that EXECUTE the query: they are a
      // round trip of their own, not a builder step. Unwrapped, every single-row read escaped the
      // delay, the record and the failure injection (caught 2026-10-01: "2 trips" for 9 queries).
      if (prop === 'single' || prop === 'maybeSingle') {
        return () =>
          mockTrip({ ...state }, () => {
            const failing =
              state.kind === 'read' &&
              mockFail.some((f) => f.table === state.table && (!f.select || state.select.includes(f.select)))
            const thrower = mockFail.find((f) => f.throws && f.table === state.table)
            if (state.kind === 'read' && thrower) {
              // `late`: this one rejects AFTER the others, so "first to reject" and "first in the
              // original order" disagree -- the case that tells allSettled+inOrder from Promise.all.
              const fail = () => {
                throw new Error(`${state.table} read THREW (test)`)
              }
              return thrower.late ? new Promise((r) => setTimeout(r, DELAY_MS * 3)).then(fail) : fail()
            }
            return failing ? { data: null, error: { message: `${state.table} read refused (test)` } } : value.apply(t)
          })
      }
      return (...args: unknown[]) => {
        if (prop === 'select' && state.kind === 'read') state.select = String(args[0] ?? '*')
        if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') state.kind = 'write'
        const out = value.apply(t, args)
        return out === t ? mockRecorded(t, state) : out
      }
    },
  })
}

function sequentialDepth(trips: Trip[]): number {
  let depth = 0
  let lastEnd = -Infinity
  for (const t of [...trips].sort((a, b) => a.end - b.end)) {
    if (t.start >= lastEnd) {
      depth++
      lastEnd = t.end
    }
  }
  return depth
}

function seed(over: { order?: Record<string, unknown>; restaurants?: unknown[]; receipts?: unknown[] } = {}) {
  mockDb = new InMemoryDb(
    {
      restaurants: (over.restaurants as Record<string, unknown>[]) ?? [
        { id: RESTAURANT, name: 'Mingle Brew & Pour', address: 'Windhoek', currency: 'NAD' },
      ],
      restaurant_billing_profiles: [
        { restaurant_id: RESTAURANT, vat_number: 'VAT-99887', registration_number: 'CC/2026/1', vat_registered: true },
      ],
      orders: [
        {
          id: ORDER,
          restaurant_id: RESTAURANT,
          payment_status: 'paid',
          payment_method: 'card',
          payment_reference: 'REF-4321',
          paycloud_merchant_order_no: 'FT17000000000001234',
          paid_at: '2026-09-01T10:00:00Z',
          subtotal: 87,
          tax: 13,
          total: 100,
          items: [{ menu_item_id: testUuid('mi'), name: 'Flat white', quantity: 1, subtotal: 87, tax: 13, total: 100 }],
          table_number: 3,
          channel: 'table',
          customer_name: null,
          order_instructions: null,
          ...over.order,
        },
      ],
      payment_events: [
        {
          restaurant_id: RESTAURANT,
          event_type: 'sale',
          amount: 105,
          transaction_id: 'TX-1',
          business_order_no: 'FT17000000000001234',
          order_ids: [ORDER],
          created_at: '2026-09-01T10:00:01Z',
        },
      ],
      payment_tips: [{ restaurant_id: RESTAURANT, payment_reference: 'REF-4321', tip_cents: 500 }],
      receipt_documents: (over.receipts as Record<string, unknown>[]) ?? [],
    },
    {
      receipt_documents: {
        defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-09-01T10:00:05Z' },
        unique: [['order_id', 'document_type', 'version']],
      },
    },
  )
}

async function issue() {
  mockTrips = []
  try {
    const receipt = await issueReceiptForOrder(ORDER)
    return { receipt, error: null as string | null, trips: mockTrips, depth: sequentialDepth(mockTrips) }
  } catch (e) {
    return { receipt: null, error: e instanceof Error ? e.message : String(e), trips: mockTrips, depth: sequentialDepth(mockTrips) }
  }
}

beforeEach(() => {
  mockFail = []
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('round trips', () => {
  it('LATENCY: the reads that need only the order go out together', async () => {
    seed()
    const r = await issue()
    console.info(`[latency] receipt issuance: ${r.trips.length} trips, depth ${r.depth}`)
    expect(r.error).toBeNull()
    // MEASURED at 682a2b2e with this harness: 9 trips, depth 9 (existing, order, restaurant,
    // billing, vat_registered, sales, tip, number, insert -- in a row). The number and the insert
    // stay sequential: the insert needs the number.
    expect(r.depth).toBeLessThanOrEqual(4)
  })
})

describe('what is issued is unchanged', () => {
  it('the snapshot carries the outlet, VAT answer, payment and gratuity exactly as before', async () => {
    seed()
    const r = await issue()
    const s = r.receipt!.snapshot_json
    expect(s.outlet).toMatchObject({
      restaurant_name: 'Mingle Brew & Pour',
      address: 'Windhoek',
      currency: 'NAD',
      vat_number: 'VAT-99887',
      registration_number: 'CC/2026/1',
      vat_registered: true,
    })
    expect((s as { tip_amount?: number }).tip_amount ?? (s.totals as { tip?: number }).tip).toBe(5)
    // The reference is masked on the receipt; the sale event's amount and time are what it shows.
    expect(s.payments).toEqual([
      { method: 'card', masked_reference: '****', amount: 105, paid_at: '2026-09-01T10:00:01Z' },
    ])
    expect(mockDb.rows('receipt_documents')).toHaveLength(1)
  })

  it('an existing receipt is returned as it is: nothing allocated, nothing inserted', async () => {
    seed({ receipts: [{ id: testUuid('rcpt'), order_id: ORDER, document_type: 'SALE_RECEIPT', version: 1, document_number: 'RCT-1' }] })
    const r = await issue()
    expect(r.error).toBeNull()
    expect(r.receipt!.document_number).toBe('RCT-1')
    expect(r.trips.some((t) => t.kind !== 'read')).toBe(false)
    expect(mockDb.rows('receipt_documents')).toHaveLength(1)
  })

  it('an existing receipt is returned even when the order is unreadable (it was checked first)', async () => {
    seed({ receipts: [{ id: testUuid('rcpt'), order_id: ORDER, document_type: 'SALE_RECEIPT', version: 1, document_number: 'RCT-2' }] })
    mockFail = [{ table: 'orders' }]
    const r = await issue()
    expect(r.error).toBeNull()
    expect(r.receipt!.document_number).toBe('RCT-2')
  })

  it('an order that is not paid is refused, nothing allocated or inserted', async () => {
    seed({ order: { payment_status: 'pending' } })
    const r = await issue()
    expect(r.error).toMatch(/has not reached final paid state \(payment_status=pending\)/)
    expect(r.trips.some((t) => t.kind !== 'read')).toBe(false)
  })
})

describe('failures resolve exactly as they did one-at-a-time', () => {
  it('restaurant missing AND sales unreadable: the RESTAURANT error wins (it was checked first)', async () => {
    seed({ restaurants: [] })
    mockFail = [{ table: 'payment_events' }]
    const r = await issue()
    expect(r.error).toBe(`issueReceiptForOrder: restaurant not found (${RESTAURANT})`)
    expect(r.trips.some((t) => t.kind !== 'read')).toBe(false)
  })

  it('restaurant read THROWS and tip read THROWS: the restaurant exception surfaces, as it would have first', async () => {
    seed()
    mockFail = [
      { table: 'payment_tips', throws: true },
      // The restaurant check came FIRST one-at-a-time, but here it rejects LAST.
      { table: 'restaurants', throws: true, late: true },
    ]
    const r = await issue()
    expect(r.error).toBe('restaurants read THREW (test)')
    expect(r.trips.some((t) => t.kind !== 'read')).toBe(false)
  })

  it('sales unreadable: refused with the sales error, nothing inserted', async () => {
    seed()
    mockFail = [{ table: 'payment_events' }]
    const r = await issue()
    expect(r.error).toMatch(/^issueReceiptForOrder: failed to load payment events for order .*: payment_events read refused \(test\)$/)
    expect(mockDb.rows('receipt_documents')).toHaveLength(0)
  })

  it('billing profile unreadable: still issued, without the VAT and registration numbers', async () => {
    seed()
    mockFail = [{ table: 'restaurant_billing_profiles', select: 'vat_number' }]
    const r = await issue()
    expect(r.error).toBeNull()
    expect(r.receipt!.snapshot_json.outlet).toMatchObject({ vat_number: null, registration_number: null, vat_registered: true })
  })

  it('vat_registered unreadable (column absent): still issued, the answer frozen as unknown', async () => {
    seed()
    mockFail = [{ table: 'restaurant_billing_profiles', select: 'vat_registered' }]
    const r = await issue()
    expect(r.error).toBeNull()
    expect(r.receipt!.snapshot_json.outlet.vat_number).toBe('VAT-99887')
    expect(r.receipt!.snapshot_json.outlet.vat_registered ?? null).toBeNull()
  })

  it('tip unreadable: still issued, the gratuity ABSENT (not zero)', async () => {
    seed()
    mockFail = [{ table: 'payment_tips' }]
    const r = await issue()
    expect(r.error).toBeNull()
    const s = r.receipt!.snapshot_json as unknown as Record<string, any>
    expect(s.tip_amount ?? s.totals?.tip).toBeUndefined()
  })
})
