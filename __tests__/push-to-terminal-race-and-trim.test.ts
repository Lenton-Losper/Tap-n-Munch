/**
 * QA (independent verification of PR #113).
 *
 * The PR's own "LOST RACE" test never enters the minting branch, so it cannot detect
 * a broken re-read. These tests use a supabase mock that models PostgREST filter
 * SEMANTICS (a .eq()/.is() guard only matches when the row actually satisfies it),
 * so the compare-and-swap is genuinely exercised.
 */
import { POST } from '@/app/api/payments/push-to-terminal/route'

const CALLER_RESTAURANT = 'rest-uuid-1'

let row: Record<string, unknown>
let sentMerchantOrderNo: string | undefined
let moWrites = 0
/** Runs immediately before a guarded MO update is evaluated, to simulate a concurrent writer. */
let beforeGuardedWrite: (() => void) | null = null

function rowMatches(filters: Array<[string, unknown]>): boolean {
  return filters.every(([col, val]) => row[col] === val)
}

function makeSupabaseMock(): any {
  return {
    from(table: string) {
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
        select() {
          const b: any = {
            eq: () => b,
            single: async () => ({ data: { ...row }, error: null }),
            maybeSingle: async () => ({ data: { ...row }, error: null }),
          }
          return b
        },
        update(patch: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = []
          const touchesMo = 'paycloud_merchant_order_no' in patch
          const b: any = {
            eq(col: string, val: unknown) {
              filters.push([col, val])
              return b
            },
            is(col: string, val: unknown) {
              filters.push([col, val])
              return b
            },
            select: () => b,
            async maybeSingle() {
              if (touchesMo) {
                if (beforeGuardedWrite) {
                  beforeGuardedWrite()
                  beforeGuardedWrite = null
                }
                // Faithful CAS: only apply when the row still satisfies every filter.
                if (!rowMatches(filters)) return { data: null, error: null }
                moWrites++
              }
              Object.assign(row, patch)
              return { data: { ...row }, error: null }
            },
            then(resolve: (v: unknown) => void) {
              if (rowMatches(filters)) Object.assign(row, patch)
              resolve({ data: [{ ...row }], error: null })
            },
          }
          return b
        },
      }
    },
  }
}

jest.mock('@/lib/permissions', () => ({ PERMISSIONS: { PAYMENTS_PROCESS: 'payments.process' } }))
jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (v: unknown) => v instanceof Response,
  requireCallerRestaurantPermission: async () => ({
    supabase: makeSupabaseMock(),
    restaurantId: CALLER_RESTAURANT,
  }),
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'M1', storeNo: 'S1', terminalSn: 'SN1' }),
}))
jest.mock('@/payments/signature', () => ({
  loadPrivateKey: () => 'PEM',
  signUtf8WithForgePkcs1RsaSha256: () => 'RAWSIG',
  formatPaycloudRequestSignature: () => 'SIG',
}))
jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeSupabaseMock() }))

beforeEach(() => {
  process.env.PAYCLOUD_APP_ID = 'APP1'
  sentMerchantOrderNo = undefined
  moWrites = 0
  beforeGuardedWrite = null
  row = {
    id: 'ord-1',
    restaurant_id: CALLER_RESTAURANT,
    payment_status: 'unpaid',
    total: 100,
    paycloud_merchant_order_no: null,
  }
  global.fetch = jest.fn(async (_url: unknown, init: any) => {
    sentMerchantOrderNo = JSON.parse(String(init.body)).merchant_order_no
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

describe('push-to-terminal -- genuine race + normalisation', () => {
  it('REAL LOST RACE: column is null at claim time, a concurrent writer wins, and we must adopt the winner value', async () => {
    row.paycloud_merchant_order_no = null
    // Concurrent push commits its value in the window between our read and our guarded write.
    beforeGuardedWrite = () => {
      row.paycloud_merchant_order_no = 'FTWINNER0000001'
    }

    const res = await push()

    expect(res.status).toBe(200)
    // The guarded .is(null) write must have matched nothing.
    expect(moWrites).toBe(0)
    // And we must send the winner's value, not our own mint.
    expect(sentMerchantOrderNo).toBe('FTWINNER0000001')
    expect(row.paycloud_merchant_order_no).toBe('FTWINNER0000001')
  })

  it('mints and sends its own value when it genuinely wins the null race', async () => {
    row.paycloud_merchant_order_no = null

    await push()

    expect(moWrites).toBe(1)
    expect(String(sentMerchantOrderNo)).toMatch(/^FT\d+/)
    expect(row.paycloud_merchant_order_no).toBe(sentMerchantOrderNo)
  })

  it('NORMALISATION: a whitespace-padded stored value is NOT reused -- wire and DB stay byte-identical', async () => {
    // Regression guard. Safety used to be judged on the TRIMMED value, so a padded but
    // otherwise-legal value was accepted as reusable: the wire got 'FT1700000000001' while
    // the column kept '  FT1700000000001  '. resolveOrderIdsByMerchantOrderNo
    // (resolve-order-by-merchant-order.ts:14-20) matches byte-exact, so a notify carrying
    // the wire value could never find the row -- the orphaned-webhook failure this route's
    // fix exists to prevent, reintroduced by normalisation drift.
    row.paycloud_merchant_order_no = '  FT1700000000001  '

    await push()

    // The padded value is treated as unusable and replaced with a clean minted one.
    expect(moWrites).toBe(1)
    expect(String(sentMerchantOrderNo)).toMatch(/^FT\d+$/)
    // The invariant that actually matters: what we transmit is exactly what we stored.
    expect(row.paycloud_merchant_order_no).toBe(sentMerchantOrderNo)
    expect(String(sentMerchantOrderNo)).toBe(String(sentMerchantOrderNo).trim())
  })

  it('CAS targets the RAW stored value, so a padded row is actually matched and replaced', async () => {
    // Guarding on the trimmed form would never match a padded row: .eq() is byte-exact,
    // so the replacement would silently apply to nothing and the route would 500.
    row.paycloud_merchant_order_no = '   FT1700000000009   '

    const res = await push()

    expect(res.status).toBe(200)
    expect(moWrites).toBe(1)
    expect(row.paycloud_merchant_order_no).not.toContain(' ')
  })

  it('an unsafe (non-padding) value IS replaced, and the CAS targets that exact value', async () => {
    row.paycloud_merchant_order_no = 'bad value!!'

    await push()

    expect(moWrites).toBe(1)
    expect(String(sentMerchantOrderNo)).toMatch(/^FT\d+/)
    expect(row.paycloud_merchant_order_no).toBe(sentMerchantOrderNo)
  })

  it('does NOT strand the order in terminal_pending on the success path', async () => {
    row.paycloud_merchant_order_no = null
    await push()
    expect(row.payment_status).toBe('terminal_pending')
    expect(row.terminal_status).toBe('pending')
  })
})
