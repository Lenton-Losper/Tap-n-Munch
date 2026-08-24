/**
 * Regression tests: POST /api/payments/push-to-terminal must NOT rotate an existing
 * orders.paycloud_merchant_order_no.
 *
 * The previous logic was:
 *   const merchantOrderNo = existingMo
 *     ? `FT${Date.now()}${rand4}`.slice(0, 32)     // existing -> minted a NEW value
 *     : existingMo || `FT${Date.now()}`.slice(0, 32)  // absent  -> also minted
 * Both branches minted, so every push overwrote the column. If a card had already been
 * charged under the previous businessOrderNo, Finatic's notify for that attempt could no
 * longer be correlated (resolveOrderIdsByMerchantOrderNo finds nothing), so the payment
 * was never recorded: money taken, order left unpaid.
 *
 * lib/payments/terminal-merchant-order.ts:39-42 documents this as forbidden --
 * "Does not rotate on every call (that would orphan webhooks for the previous
 * businessOrderNo)."
 */
import { POST } from '@/app/api/payments/push-to-terminal/route'

const CALLER_RESTAURANT = 'rest-uuid-1'

let orderRow: Record<string, unknown>
/** Every UPDATE the route issues: patch + the columns it filtered on. */
let updates: Array<{ patch: Record<string, unknown>; filterCols: string[] }> = []
/** Simulates another request having already claimed the column (lost race). */
let raceWinnerValue: string | null = null

jest.mock('@/lib/permissions', () => ({ PERMISSIONS: { PAYMENTS_PROCESS: 'payments.process' } }))

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (v: unknown) => v instanceof Response,
  requireCallerRestaurantPermission: async () => ({
    supabase: makeSupabaseMock(),
    restaurantId: CALLER_RESTAURANT,
  }),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'M1',
    storeNo: 'S1',
    terminalSn: 'SN1',
  }),
}))

jest.mock('@/payments/signature', () => ({
  loadPrivateKey: () => 'PEM',
  signUtf8WithForgePkcs1RsaSha256: () => 'RAWSIG',
  formatPaycloudRequestSignature: () => 'SIG',
}))

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      // audit_logs, taught to this fake 2026-08-24 (#331).
      //
      // The route has called markPaymentAttemptStarted since the 2026-08-02 merge cdc7502, and that
      // helper READS and INSERTS audit_logs and RETHROWS its errors. This fake threw on any table
      // but `orders`, so that throw reached the route's outer catch and every push() returned 500.
      //
      // Only the assertions that check res.status noticed. The rest of this file was green over a
      // 500 for three weeks, reading as coverage of the terminal push path while exercising the
      // error handler. That is the reason this repair matters more than the red count suggested.
      if (table === 'audit_logs') {
        const b: any = {
          select: () => b,
          eq: () => b,
          order: () => b,
          limit: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
          insert: async () => ({ error: null }),
        }
        return b
      }
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            single: async () => ({ data: orderRow, error: null }),
            maybeSingle: async () => ({ data: orderRow, error: null }),
          }
          return b
        },
        update: (patch: Record<string, unknown>) => {
          const filters: string[] = []
          let isNullCol: string | null = null
          const b: Record<string, unknown> = {
            eq(col: string) {
              filters.push(col)
              return b
            },
            is(col: string, _v: unknown) {
              isNullCol = col
              filters.push(col)
              return b
            },
            select() {
              return b
            },
            maybeSingle: async () => {
              updates.push({ patch, filterCols: [...filters] })
              // .is('paycloud_merchant_order_no', null) only matches when the column is
              // actually null AND no concurrent writer won the race.
              if (isNullCol === 'paycloud_merchant_order_no') {
                if (raceWinnerValue !== null || orderRow.paycloud_merchant_order_no) {
                  return { data: null, error: null } // matched no row
                }
                Object.assign(orderRow, patch)
                return { data: patch, error: null }
              }
              Object.assign(orderRow, patch)
              return { data: { ...orderRow }, error: null }
            },
            then(resolve: (v: unknown) => void) {
              updates.push({ patch, filterCols: [...filters] })
              Object.assign(orderRow, patch)
              resolve({ data: [orderRow], error: null })
            },
          }
          return b
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeSupabaseMock() }))

/** Captures the merchant_order_no actually sent to Finatic. */
let sentMerchantOrderNo: string | undefined

beforeEach(() => {
  process.env.PAYCLOUD_APP_ID = 'APP1' // route reads app id from env, not credentials
  updates = []
  raceWinnerValue = null
  sentMerchantOrderNo = undefined
  orderRow = {
    id: 'ord-1',
    restaurant_id: CALLER_RESTAURANT,
    payment_status: 'unpaid',
    total: 100,
    paycloud_merchant_order_no: null,
  }
  global.fetch = jest.fn(async (_url: unknown, init: Record<string, unknown>) => {
    const body = JSON.parse(String((init as { body: string }).body))
    sentMerchantOrderNo = body.merchant_order_no
    return {
      ok: true,
      status: 200,
      clone: () => ({ text: async () => '{}' }),
      json: async () => ({ code: '0', data: { ok: true } }),
    }
  }) as unknown as typeof fetch
})

const push = () =>
  POST(
    new Request('https://example.test/api/payments/push-to-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ord-1', tableNumber: 7, orderNumber: 42 }),
    }),
  )

/** Updates that write the merchant order column. */
const moWrites = () => updates.filter((u) => 'paycloud_merchant_order_no' in u.patch)

describe('push-to-terminal -- merchant order number must not rotate', () => {
  it('REUSES an existing merchant order no and issues NO write to that column', async () => {
    orderRow.paycloud_merchant_order_no = 'FT17000000001234'

    const res = await push()
    expect(res.status).toBe(200)

    // The critical assertion: the in-flight value reaches Finatic unchanged...
    expect(sentMerchantOrderNo).toBe('FT17000000001234')
    // ...and the column was never overwritten, so a notify for it still correlates.
    expect(moWrites()).toHaveLength(0)
    expect(orderRow.paycloud_merchant_order_no).toBe('FT17000000001234')
  })

  it('mints a value only when the column is null, guarded by .is(null)', async () => {
    orderRow.paycloud_merchant_order_no = null

    await push()

    const writes = moWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0].filterCols).toContain('paycloud_merchant_order_no') // the .is() guard
    expect(String(sentMerchantOrderNo)).toMatch(/^FT\d+/)
    expect(orderRow.paycloud_merchant_order_no).toBe(sentMerchantOrderNo)
  })

  // NOTE: the lost-race branch is NOT covered here. An earlier version of this file had a
  // "LOST RACE" test that set an already-SAFE value, so the route took the reuse path and
  // never entered the minting block at all -- it was a duplicate of the reuse test above
  // wearing a different name, and it stayed green when the re-read logic was deliberately
  // broken. Genuine coverage of that branch, using a mock that models PostgREST filter
  // semantics so the compare-and-swap is actually evaluated, lives in
  // __tests__/push-to-terminal-race-and-trim.test.ts.
  it('adopts an already-present value rather than overwriting it (reuse, not race)', async () => {
    orderRow.paycloud_merchant_order_no = 'FT19999999999999'

    await push()

    // We must send the winner's value, never a freshly minted one.
    expect(sentMerchantOrderNo).toBe('FT19999999999999')
    expect(moWrites()).toHaveLength(0)
  })

  it('replaces an UNSAFE existing value (it can never have been accepted on the wire)', async () => {
    orderRow.paycloud_merchant_order_no = 'bad value with spaces!!'

    await push()

    // Not reused -- an unsafe value cannot correspond to a real in-flight charge.
    expect(sentMerchantOrderNo).not.toBe('bad value with spaces!!')
    expect(String(sentMerchantOrderNo)).toMatch(/^FT\d+/)
  })

  it('CONTROL: two sequential pushes send the SAME merchant order no', async () => {
    orderRow.paycloud_merchant_order_no = null

    await push()
    const first = sentMerchantOrderNo

    await push()
    const second = sentMerchantOrderNo

    // Under the old logic these differed on every call, orphaning the first webhook.
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })
})
