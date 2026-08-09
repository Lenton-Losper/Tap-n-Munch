/**
 * #156 rollout safety: an OLD APK in the field plus the NEW server-side write must produce
 * exactly ONE payment_events row, not two.
 *
 * Terminals already deployed keep calling POST /api/terminal/payment-events/sale after every
 * card payment. The new settle route writes its own SALE row. So for the whole rollout window
 * there are two independent writers describing the same money, and either can win the race.
 *
 * Both REAL routes are exercised here -- the settle route and the sale route -- against one
 * shared fake that enforces UNIQUE (restaurant_id, idempotency_key) and reports 23505. The old
 * client is not simulated with a hand-written insert; that would prove only that my idea of
 * its payload dedups, which is the assumption actually under test.
 *
 * The dedup works only if BOTH writers derive the same idempotency_key. They do: each uses
 * business_order_no, which the terminal sends identically to both endpoints. These tests are
 * what turns that from an assumption into a measurement.
 */
import { FakeDb } from './helpers/fake-payment-events-db'

const RESTAURANT = 'rest-1'
const TERMINAL = 'term-1'
const TAB = 'tab-1'
// The sale route validates order_ids as real UUIDs, so these must be well-formed.
const ORDER_1 = '11111111-1111-4111-8111-111111111111'
const ORDER_2 = '22222222-2222-4222-8222-222222222222'
const BUSINESS_ORDER_NO = 'FT17857380998909103'

let db: FakeDb

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => db.client(),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'rest-1',
    terminalId: 'term-1',
    deviceSerial: 'SN-1',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => {},
}))

jest.mock('@/lib/payment-reference', () => ({ generatePaymentReference: () => 'PAYREF' }))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({ safeIssueReceiptsForOrders: async () => {} }))
jest.mock('@/lib/tabs/settle-tab-state', () => ({ clearReadyToPayAndReopenTab: async () => {} }))
jest.mock('@/lib/terminal-auth/consume-authorization-token', () => ({
  consumeAuthorizationToken: async () => ({ ok: true }),
}))
// The sale route issues receipts in the background; irrelevant here and must not throw.
jest.mock('@/lib/receipts/issueReceipt', () => ({ issueReceiptForOrder: async () => {} }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: settlePost } = require('@/app/api/terminal/tabs/[tabId]/settle/route')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: salePost } = require('@/app/api/terminal/payment-events/sale/route')

function seed(orderIds: string[] = [ORDER_1], total = 35) {
  db = new FakeDb()
  db.tables.tabs.push({
    id: TAB,
    restaurant_id: RESTAURANT,
    table_id: 'table-1',
    total,
    status: 'open',
    settled_at: null,
  })
  for (const id of orderIds) {
    db.tables.orders.push({
      id,
      tab_id: TAB,
      restaurant_id: RESTAURANT,
      total: total / orderIds.length,
      payment_status: 'pending',
      terminal_pushed_at: null,
      paycloud_merchant_order_no: null,
    })
  }
}

/** The NEW path: the server writes the ledger row as part of settling. */
function newServerSettle(orderIds: string[] = [ORDER_1], amount = 35) {
  return settlePost(
    new Request(`https://x.test/api/terminal/tabs/${TAB}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_ids: orderIds,
        amount,
        method: 'card',
        business_order_no: BUSINESS_ORDER_NO,
        voucher_no: BUSINESS_ORDER_NO,
      }),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
}

/**
 * The OLD path, exactly as a deployed terminal calls it: recordSaleEvent ->
 * POST /api/terminal/payment-events/sale. transaction_id and business_order_no are the same
 * value, which is what order #120 shows a real terminal sending.
 */
function oldApkSalePost(orderIds: string[] = [ORDER_1], amount = 35) {
  return salePost(
    new Request('https://x.test/api/terminal/payment-events/sale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_ids: orderIds,
        business_order_no: BUSINESS_ORDER_NO,
        transaction_id: BUSINESS_ORDER_NO,
        amount,
        currency: 'NAD',
        app_version: '1.34',
      }),
    }),
  )
}

describe('the two writers derive the SAME idempotency key', () => {
  it('the settle route keys on business_order_no', async () => {
    seed()
    await newServerSettle()
    expect(db.saleRows()[0].idempotency_key).toBe(BUSINESS_ORDER_NO)
  })

  it('the old-client sale route keys on the same business_order_no', async () => {
    seed()
    await oldApkSalePost()
    expect(db.saleRows()[0].idempotency_key).toBe(BUSINESS_ORDER_NO)
  })

  it('so the two keys are identical, which is what makes UNIQUE dedup them', async () => {
    seed()
    await newServerSettle()
    const fromSettle = db.saleRows()[0].idempotency_key

    seed()
    await oldApkSalePost()
    const fromOldClient = db.saleRows()[0].idempotency_key

    expect(fromSettle).toBe(fromOldClient)
  })
})

describe('ONE row regardless of which writer wins the race', () => {
  it('settle first, then the old APK posts — exactly one row', async () => {
    seed()

    const settleRes = await newServerSettle()
    expect(settleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)

    const saleRes = await oldApkSalePost()

    // The old client must not be handed an error for a row that already correctly exists --
    // a 500 there would make a deployed terminal retry forever.
    expect(saleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)
  })

  it('old APK first, then settle — exactly one row', async () => {
    seed()

    const saleRes = await oldApkSalePost()
    expect(saleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)

    const settleRes = await newServerSettle()

    // The settlement still succeeds; the ledger row was simply already there.
    expect(settleRes.status).toBe(200)
    await expect(settleRes.json()).resolves.toMatchObject({
      success: true,
      sale_ledger_outcome: 'already_recorded',
    })
    expect(db.saleRows()).toHaveLength(1)
  })

  it('the surviving row points at the right order and amount either way', async () => {
    seed()
    await newServerSettle()
    await oldApkSalePost()
    const afterSettleFirst = db.saleRows()[0]

    seed()
    await oldApkSalePost()
    await newServerSettle()
    const afterOldFirst = db.saleRows()[0]

    for (const row of [afterSettleFirst, afterOldFirst]) {
      expect(row.order_ids).toEqual([ORDER_1])
      expect(Number(row.amount)).toBe(35)
      expect(row.business_order_no).toBe(BUSINESS_ORDER_NO)
    }
  })

  it('holds for a multi-order tab settle too', async () => {
    seed([ORDER_1, ORDER_2], 60)
    await newServerSettle([ORDER_1, ORDER_2], 60)
    await oldApkSalePost([ORDER_1, ORDER_2], 60)

    expect(db.saleRows()).toHaveLength(1)
    expect(db.saleRows()[0].order_ids).toEqual([ORDER_1, ORDER_2])
  })

  it('a repeated old-APK post still leaves one row', async () => {
    // Terminals retry. Three posts, one row.
    seed()
    await newServerSettle()
    await oldApkSalePost()
    await oldApkSalePost()

    expect(db.saleRows()).toHaveLength(1)
  })
})

describe('which writer won is still distinguishable afterwards', () => {
  it('reason_code says settle_card when the server wrote it', async () => {
    seed()
    await newServerSettle()
    await oldApkSalePost()
    expect(db.saleRows()[0].reason_code).toBe('settle_card')
  })

  it('reason_code says sale when the old client got there first', async () => {
    // Useful during rollout: it shows at a glance which venues are still on the old APK.
    seed()
    await oldApkSalePost()
    await newServerSettle()
    expect(db.saleRows()[0].reason_code).toBe('sale')
  })
})

/**
 * The amount comparison is what turns a 23505 into `already_recorded`, and it is where the two
 * writers legitimately differ: the settle route records the SERVER total while the terminal
 * posts what it actually charged, and the settle route itself accepts a client amount up to
 * PAYMENT_AMOUNT_TOLERANCE away. An exact === comparison therefore rejects differences the
 * route deliberately allowed.
 */
describe('amounts that differ for legitimate reasons still resolve to one row', () => {
  it('a float-sum tab total dedups against the terminal\'s clean 2dp figure', async () => {
    // 12.50 + 19.99 === 32.489999999999995, not 32.49. Roughly a quarter of two-order sums
    // land off the 2dp value like this, and payment_events.amount is numeric with no scale,
    // so nothing rounds it away. This is the case that breaks on ===.
    expect(12.5 + 19.99).not.toBe(32.49)

    seed([ORDER_1, ORDER_2], 32.49)
    db.tables.orders[0].total = 12.5
    db.tables.orders[1].total = 19.99

    const settleRes = await newServerSettle([ORDER_1, ORDER_2], 32.49)
    expect(settleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)
    // Stored as the monetary value, not the binary artefact of the sum.
    expect(db.saleRows()[0].amount).toBe(32.49)

    // The old APK posts the amount it charged: a clean 32.49.
    const saleRes = await oldApkSalePost([ORDER_1, ORDER_2], 32.49)

    expect(saleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)
  })

  it('the same float-sum case the other way round — old APK first, then settle', async () => {
    seed([ORDER_1, ORDER_2], 32.49)
    db.tables.orders[0].total = 12.5
    db.tables.orders[1].total = 19.99

    await oldApkSalePost([ORDER_1, ORDER_2], 32.49)
    const settleRes = await newServerSettle([ORDER_1, ORDER_2], 32.49)

    await expect(settleRes.json()).resolves.toMatchObject({
      success: true,
      sale_ledger_outcome: 'already_recorded',
    })
    expect(db.saleRows()).toHaveLength(1)
  })

  it('a one-cent difference — which the settle route explicitly tolerates — is not a conflict', async () => {
    // 20.00 vs 19.99 deliberately, NOT 35 vs 34.99. A float tolerance accepts the latter
    // (diff 0.00999999999999801) and rejects the former (0.010000000000001563), so the
    // original choice of numbers passed while the code was still wrong -- staging caught it
    // with 32.49 vs 32.48. Picking a pair on the failing side is what makes this a control.
    expect(Math.abs(20 - 19.99) <= 0.01).toBe(false)

    seed([ORDER_1], 20)
    await newServerSettle([ORDER_1], 20)
    expect(db.saleRows()).toHaveLength(1)

    const saleRes = await oldApkSalePost([ORDER_1], 19.99)

    expect(saleRes.status).toBe(200)
    expect(db.saleRows()).toHaveLength(1)
  })

  it('a tolerated cent does NOT raise a critical ledger-gap alert', async () => {
    // The consequence of getting this wrong is not just a 409: it is a
    // requiresAttention:true critical alert on the ops console for a payment with a single
    // correct row and nothing wrong with it.
    seed([ORDER_1], 20)
    await oldApkSalePost([ORDER_1], 19.99)
    const settleRes = await newServerSettle([ORDER_1], 20)

    await expect(settleRes.json()).resolves.toMatchObject({
      sale_ledger_outcome: 'already_recorded',
    })
    expect(db.auditRows('payment.sale_ledger_write_failed')).toHaveLength(0)
    expect(db.saleRows()).toHaveLength(1)
  })

  it('two cents apart is still a genuine conflict — the tolerance is one cent, not "close"', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      seed([ORDER_1], 20)
      await newServerSettle([ORDER_1], 20)
      const saleRes = await oldApkSalePost([ORDER_1], 19.98)

      expect(saleRes.status).toBe(409)
      expect(db.saleRows()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a genuine disagreement is surfaced, not silently doubled', () => {
  it('the same reference with a different amount does not create a second row', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      seed()
      await newServerSettle()
      // The old client reports a different amount under the same reference.
      const saleRes = await oldApkSalePost([ORDER_1], 99)

      expect(saleRes.status).toBe(409)
      expect(db.saleRows()).toHaveLength(1)
      expect(Number(db.saleRows()[0].amount)).toBe(35)
    } finally {
      spy.mockRestore()
    }
  })

  it('the same reference over different orders does not create a second row', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      seed([ORDER_1, ORDER_2], 60)
      await newServerSettle([ORDER_1], 30)
      const saleRes = await oldApkSalePost([ORDER_2], 30)

      expect(saleRes.status).toBe(409)
      expect(db.saleRows()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})
