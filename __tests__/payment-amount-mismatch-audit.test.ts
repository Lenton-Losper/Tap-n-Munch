/**
 * #187 — a charged payment refused for an amount mismatch must leave a durable trace.
 *
 * The issue's headline case: POST /api/terminal/orders/[orderId]/payment on the SUCCESS path
 * refuses a mismatch with a 400 AFTER WiseCashier has charged the card. The refusal itself is
 * correct — the figures genuinely disagree — but the order then stays `pending`, no
 * payment_events SALE row is written, and it is later swept as auto_timeout or cancelled by
 * hand as "no charge found". As the issue puts it: nothing in the record distinguishes it from
 * a genuine abandonment. At the callback route the refusal wrote NOTHING, not even a log line;
 * at verify-payment it wrote a console.error, which cannot be queried by whoever reconciles a
 * disputed charge days later.
 *
 * WHY THE TEST IS HERE AND NOT ON THE ROUTE. Neither route can be loaded under ts-jest:
 * app/api/terminal/orders/[orderId]/payment/route.ts imports @/lib/terminal-auth, which imports
 * `jose` — ESM-only, untransformed, fails at import. Same reason
 * __tests__/terminal-payment-failed-amount-guard.test.ts tests the lib function rather than the
 * route it is reached through. The behaviour therefore lives in a lib module so it can be
 * covered at all.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE, because it is deliberately not implemented: #187
 * suggests recording such a payment as PAID with a mismatch warning. That is a decision about
 * what a payment means and it is not taken. The neighbouring path already rejected the close
 * relative of it — handle-terminal-payment-failed.ts refuses to "correct to paid using the
 * order total" because a mis-correlated reference would mark THIS order paid on somebody
 * else's money. Ruling packet raised; nothing here changes the money.
 */
import { recordPaymentAmountMismatch } from '@/lib/payments/record-amount-mismatch'

const ORDER_ID = '9f8d3c2b-1a4e-4f6d-8b0c-2e5a7d9f1c33'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

/** Minimal stand-in for the supabase client: records what was inserted, into which table. */
function fakeSupabase(behaviour: 'ok' | 'error' | 'throw' = 'ok') {
  const inserts: Array<{ table: string; row: Record<string, any> }> = []
  const client = {
    from(table: string) {
      return {
        insert: async (row: Record<string, any>) => {
          inserts.push({ table, row })
          if (behaviour === 'throw') throw new Error('connection reset')
          if (behaviour === 'error') return { error: { message: 'permission denied' } }
          return { error: null }
        },
      }
    },
  }
  return { client: client as any, inserts }
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('recordPaymentAmountMismatch', () => {
  it('writes one audit_logs row carrying BOTH figures', async () => {
    const { client, inserts } = fakeSupabase()

    const result = await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: 2997,
      source: 'terminal_callback',
      terminalId: 'term-1',
      businessOrderNo: 'FT17860156979870443',
      reference: 'ref-1',
    })

    expect(result.recorded).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('audit_logs')

    const row = inserts[0].row
    expect(row.action).toBe('payment.amount_mismatch')
    expect(row.entity_type).toBe('order')
    expect(row.entity_id).toBe(ORDER_ID)
    expect(row.restaurant_id).toBe(RESTAURANT_ID)

    // Both figures, or the disagreement cannot be settled from the row alone -- the same
    // convention payment.verification_uncertain already follows.
    expect(row.metadata.expectedAmount).toBe(120)
    expect(row.metadata.receivedAmount).toBe(2997)
    expect(row.metadata.businessOrderNo).toBe('FT17860156979870443')
    expect(row.metadata.source).toBe('terminal_callback')
  })

  it('names the outcome so the row is not read as an accepted payment', async () => {
    const { client, inserts } = fakeSupabase()

    await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: 121.5,
      source: 'terminal_callback',
    })

    expect(inserts[0].row.metadata.outcome).toBe('refused_left_pending')
    // The order is NOT touched. This module writes to audit_logs and nothing else -- if it ever
    // starts writing `orders`, that is the money-semantics change #187 proposes and it needs a
    // ruling first.
    expect(inserts.map((i) => i.table)).toEqual(['audit_logs'])
  })

  it('records an unreadable reported amount as null rather than coercing it', async () => {
    const { client, inserts } = fakeSupabase()

    await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: null,
      source: 'terminal_callback',
    })

    // Not 0. A zero here would read as "the terminal reported a zero charge", which is a
    // different and materially misleading claim.
    expect(inserts[0].row.metadata.receivedAmount).toBeNull()
  })

  it('distinguishes the verify-payment source from the callback source', async () => {
    const { client, inserts } = fakeSupabase()

    await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: 119,
      source: 'terminal_verify_payment',
    })

    expect(inserts[0].row.metadata.source).toBe('terminal_verify_payment')
  })

  // The two that matter most: both call sites sit on a path where the card is already charged,
  // so this function must never be able to convert a specific 400 into a generic 500.
  it('reports a failed insert without throwing', async () => {
    const { client } = fakeSupabase('error')

    const result = await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: 121,
      source: 'terminal_callback',
    })

    expect(result.recorded).toBe(false)
    expect(result.error).toBe('permission denied')
  })

  it('swallows a thrown insert without throwing', async () => {
    const { client } = fakeSupabase('throw')

    // If this rejects, the route's generic catch answers 500 instead of the specific
    // AMOUNT_MISMATCH 400, and the staff-facing error stops naming the actual problem.
    const result = await recordPaymentAmountMismatch(client, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      expectedAmount: 120,
      receivedAmount: 121,
      source: 'terminal_callback',
    })

    expect(result.recorded).toBe(false)
    expect(result.error).toBe('connection reset')
  })
})
