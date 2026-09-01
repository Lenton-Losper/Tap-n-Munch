/**
 * THE PAYMENT LIFECYCLE, one order at a time, through every outcome a real card can produce.
 *
 * initiation → terminal result → server confirmation → idempotency → settlement → receipt
 *
 * ============================================================================================
 * WHY A LIFECYCLE SUITE WHEN 47 PAYMENT SUITES ALREADY EXIST
 * ============================================================================================
 *
 * The existing coverage is good and it is scattered: duplicates in one file, cancellation in
 * another, the false-failure guard in a third. Not one of them walks a single order from
 * unpaid to receipted and then tries to break it, which is the only way to see the interactions
 * — that a duplicate callback must not mint a second receipt, that a decline must leave no
 * receipt at all, and that an UNREACHABLE gateway must leave the order pending rather than
 * guessing in either direction.
 *
 * The real modules run: `markOrderPaidConfirmed`, `handleTerminalPaymentFailed`,
 * `safeIssueReceiptForOrder` and `issueReceiptForOrder`, against one shared in-memory store, so a
 * write made by one is seen by the next.
 *
 * NOTHING HERE CHARGES A CARD. The gateway is an injected function (`queryFinaticOrderPaidFn`,
 * the seam the handler already exposes), and no network call is made.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

const RESTAURANT = testUuid('rest')
const TAB = testUuid('tab')
const ORDER = testUuid('ord')
const MERCHANT_ORDER_NO = 'FT-TEST-0001'

const dbRef = { current: new InMemoryDb() }

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => dbRef.current.client(),
}))

// Credentials are irrelevant here: every test injects the gateway result directly.
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'M-TEST',
    storeNo: 'S-TEST',
    terminalSn: null,
    checkoutMerchantNo: 'M-TEST',
    checkoutStoreNo: 'S-TEST',
  }),
  MissingFinaticCredentialsError: class extends Error {},
  isMissingFinaticCredentialsError: () => false,
  MISSING_FINATIC_CREDENTIALS_MESSAGE: 'missing',
}))

import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { handleTerminalPaymentFailed } from '@/lib/payments/handle-terminal-payment-failed'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'

type Row = Record<string, unknown>
const order = () => dbRef.current.rows('orders')[0] as Row
const receipts = () => dbRef.current.rows('receipt_documents')
const audits = () => dbRef.current.rows('audit_logs')

function seed(overrides: Row = {}) {
  dbRef.current = new InMemoryDb(
    {
      restaurants: [{ id: RESTAURANT, name: 'Riviera', address: 'Windhoek', currency: 'NAD' }],
      restaurant_billing_profiles: [],
      tabs: [{ id: TAB, restaurant_id: RESTAURANT, status: 'open', total: 320 }],
      orders: [
        {
          id: ORDER,
          restaurant_id: RESTAURANT,
          tab_id: TAB,
          order_number: 41,
          table_number: 7,
          channel: 'table',
          status: 'ready',
          payment_status: 'pending',
          payment_method: 'card',
          payment_reference: null,
          payment_voucher_no: null,
          paycloud_merchant_order_no: MERCHANT_ORDER_NO,
          subtotal: 278.26,
          tax: 41.74,
          total: 320,
          paid_at: null,
          completed_at: null,
          cancelled_at: null,
          cancellation_reason: null,
          customer_name: null,
          order_instructions: null,
          items: [
            { menu_item_id: testUuid('mi'), name: 'Ribeye', quantity: 1, subtotal: 278.26, tax: 41.74, total: 320 },
          ],
          ...overrides,
        },
      ],
      audit_logs: [],
      payment_events: [],
      receipt_documents: [],
    },
    {
      receipt_documents: {
        defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-09-01T12:00:00Z' },
        unique: [['order_id', 'document_type', 'version']],
      },
    },
  )
}

const confirm = (reference: string, source = 'terminal_callback') =>
  markOrderPaidConfirmed(dbRef.current.client() as never, {
    orderId: ORDER,
    restaurantId: RESTAURANT,
    reference,
    voucherNo: reference,
    amount: 320,
    gatewayAmount: 320,
    source,
  })

/** The terminal reported a failure. `gateway` is what Finatic says when asked. */
const reportFailure = (
  gateway: (() => Promise<{ paid: boolean }>) | (() => Promise<never>),
  cancellationReason = 'payment_declined',
) =>
  handleTerminalPaymentFailed(
    dbRef.current.client() as never,
    {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      paycloudMerchantOrderNo: MERCHANT_ORDER_NO,
      cancellationReason,
      // #190: the gateway's figure is checked against THIS order before any correction to paid.
      orderTotal: 320,
    },
    { queryFinaticOrderPaidFn: gateway as never },
  )

beforeEach(() => seed())

// ── 1. the happy path ────────────────────────────────────────────────────────

describe('1. successful confirmation', () => {
  it('marks the order paid and completed, and issues exactly one receipt', async () => {
    const result = await confirm('FIN-REF-1')

    expect(result.claimed).toBe(true)
    expect(order()).toMatchObject({
      payment_status: 'paid',
      status: 'completed',
      payment_reference: 'FIN-REF-1',
    })
    expect(order().paid_at).toBeTruthy()
    expect(receipts()).toHaveLength(1)
    expect((receipts()[0] as Row).order_id).toBe(ORDER)
  })

  it('records an auditable payment.completed with whose figure the amount is', async () => {
    await confirm('FIN-REF-1')
    const audit = audits().find((a) => a.action === 'payment.completed') as Row
    expect(audit).toBeDefined()
    const meta = audit.metadata as Row
    expect(meta.amount).toBe(320)
    expect(meta.gatewayAmount).toBe(320)
    // #238/#268: the label that says whose number it is.
    expect(meta.amountMeaning).toBe('gateway_reported')
  })

  it('clears the tab balance once nothing is owed', async () => {
    await confirm('FIN-REF-1')
    expect((dbRef.current.rows('tabs')[0] as Row).total).toBe(0)
  })
})

// ── 2. duplicate callbacks and double settlement ─────────────────────────────

describe('2. duplicate callbacks and settling twice', () => {
  it('a duplicate callback is refused as already_paid and mints no second receipt', async () => {
    const first = await confirm('FIN-REF-1')
    const second = await confirm('FIN-REF-1')

    expect(first.claimed).toBe(true)
    expect(second).toMatchObject({ claimed: false, reason: 'already_paid' })
    expect(receipts()).toHaveLength(1)
  })

  /**
   * THE ONE THAT MATTERS FOR MONEY. A second, DIFFERENT reference arriving after settlement must
   * not overwrite the reference of the payment that actually happened — that is the record used
   * to reconcile against the gateway.
   */
  it('a second settlement with a different reference cannot overwrite the first', async () => {
    await confirm('FIN-REF-1')
    const second = await confirm('FIN-REF-2-LATE')

    expect(second.claimed).toBe(false)
    expect(order().payment_reference).toBe('FIN-REF-1')
    expect(order().payment_voucher_no).toBe('FIN-REF-1')
    expect(receipts()).toHaveLength(1)
  })

  it('ten concurrent callbacks settle once', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => confirm(`FIN-REF-${i}`)),
    )
    expect(results.filter((r) => r.claimed)).toHaveLength(1)
    expect(receipts()).toHaveLength(1)
    // One document number burned, not ten.
    expect(
      dbRef.current.rpcCalls.filter((c) => c.name === 'generate_document_number'),
    ).toHaveLength(1)
  })

  it('an order that was already paid before this call is left completely alone', async () => {
    seed({ payment_status: 'paid', status: 'completed', payment_reference: 'ORIGINAL' })
    const r = await confirm('LATE-DUPLICATE')
    expect(r).toMatchObject({ claimed: false, reason: 'already_paid' })
    expect(order().payment_reference).toBe('ORIGINAL')
  })
})

// ── 3. retries ───────────────────────────────────────────────────────────────

describe('3. retries', () => {
  it('a receipt that failed to issue can be issued later, and the payment stands', async () => {
    // Simulate issuance failing at settle time by removing the venue the snapshot needs.
    const restaurants = dbRef.current.rows('restaurants')
    const saved = restaurants.splice(0, 1)

    const result = await confirm('FIN-REF-1')

    // The money is settled even though the document could not be built — safeIssueReceipt
    // deliberately does not let a receipt failure undo a payment.
    expect(result.claimed).toBe(true)
    expect(order().payment_status).toBe('paid')
    expect(receipts()).toHaveLength(0)

    restaurants.push(...saved)
    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.document_number).toMatch(/^RCT-/)
    expect(receipts()).toHaveLength(1)
  })

  it('re-issuing after a successful issue returns the same document', async () => {
    await confirm('FIN-REF-1')
    const again = await issueReceiptForOrder(ORDER)
    expect(receipts()).toHaveLength(1)
    expect(again.document_number).toBe((receipts()[0] as Row).document_number)
  })
})

// ── 4-6. the terminal reported a failure ─────────────────────────────────────

describe('4. decline — the gateway agrees no money was taken', () => {
  it('cancels the order and issues no receipt', async () => {
    const r = await reportFailure(async () => ({ paid: false }), 'payment_declined')
    expect(r.outcome).toBe('cancelled')
    expect(order()).toMatchObject({ payment_status: 'cancelled', status: 'cancelled' })
    expect(order().cancellation_reason).toBe('payment_declined')
    expect(receipts()).toHaveLength(0)
  })
})

describe('5. cancellation on the reader', () => {
  it('cancels, and still asks the gateway first when a charge may have started', async () => {
    let asked = 0
    const r = await reportFailure(async () => {
      asked += 1
      return { paid: false }
    }, 'terminal_user_cancelled')
    expect(asked).toBe(1)
    expect(r.outcome).toBe('cancelled')
    expect(receipts()).toHaveLength(0)
  })

  /**
   * THE FALSE-FAILURE GUARD. The reader said it failed; Finatic says the card was charged. The
   * money is real, so the order is corrected to PAID rather than cancelled — cancelling here
   * would leave a customer charged for an order the system believes never happened.
   */
  it('a reader failure that Finatic contradicts is corrected to paid, with a receipt', async () => {
    const r = await reportFailure(async () => ({ paid: true, amount: 320 }))
    expect(r.outcome).toBe('corrected_to_paid')
    expect(order()).toMatchObject({ payment_status: 'paid', status: 'completed' })
    expect(receipts()).toHaveLength(1)
  })

  /**
   * #190. "Paid" with NO AMOUNT is not a verified payment, and it is refused — without being
   * cancelled either, because the gateway has just said the customer was charged. This is the
   * shape my own first fixture had, and the handler was right to refuse it.
   */
  it('paid with no amount is neither applied nor cancelled', async () => {
    // `amount: null`, not an omitted key: the real queryFinaticOrderPaid normalises through
    // toMoney, so an absent or unparseable field arrives as null. A fake that returns undefined
    // would be testing a shape the gateway client cannot produce.
    const r = await reportFailure(async () => ({ paid: true, amount: null }))
    expect(r.outcome).toBe('left_pending_finatic_uncertain')
    expect(order().payment_status).toBe('pending')
    expect(receipts()).toHaveLength(0)
    const audit = audits().find((a) => a.action === 'payment.verification_uncertain') as Row
    expect((audit.metadata as Row).amountVerified).toBe(false)
    // null must stay distinguishable from "checked and disagreed".
    expect((audit.metadata as Row).finaticAmount).toBeNull()
  })

  it("paid for the WRONG amount is refused rather than settled on somebody else's money", async () => {
    const r = await reportFailure(async () => ({ paid: true, amount: 999 }))
    expect(r.outcome).toBe('left_pending_finatic_uncertain')
    expect(order().payment_status).toBe('pending')
    const audit = audits().find((a) => a.action === 'payment.verification_uncertain') as Row
    expect((audit.metadata as Row).finaticAmount).toBe(999)
    expect((audit.metadata as Row).expectedAmount).toBe(320)
  })
})

describe('6. timeout / gateway unreachable', () => {
  /**
   * DELIBERATELY UNDECIDED. When Finatic cannot be reached the system does NOT guess. Cancelling
   * could strand a real charge; marking paid could hand over goods for money that never arrived.
   * It stays pending and says so, and a cron may resolve it later.
   */
  it('leaves the order PENDING rather than guessing in either direction', async () => {
    const r = await reportFailure(async () => {
      throw new Error('ETIMEDOUT')
    })

    expect(r.outcome).toBe('left_pending_finatic_uncertain')
    expect(order().payment_status).toBe('pending')
    expect(order().status).not.toBe('cancelled')
    expect(order().paid_at).toBeNull()
    expect(receipts()).toHaveLength(0)
  })

  it('records why it could not decide', async () => {
    await reportFailure(async () => {
      throw new Error('ETIMEDOUT')
    })
    const uncertain = audits().find((a) => String(a.action).includes('uncertain'))
    expect(uncertain).toBeDefined()
  })

  it('a later successful confirmation still settles it normally', async () => {
    await reportFailure(async () => {
      throw new Error('ETIMEDOUT')
    })
    const r = await confirm('FIN-REF-LATE')
    expect(r.claimed).toBe(true)
    expect(order().payment_status).toBe('paid')
    expect(receipts()).toHaveLength(1)
  })
})

// ── 7. settlement never precedes confirmation ────────────────────────────────

describe('7. a receipt is never issued for money that has not arrived', () => {
  it('an unpaid order cannot be receipted', async () => {
    await expect(issueReceiptForOrder(ORDER)).rejects.toThrow(/not reached final paid state/)
    expect(receipts()).toHaveLength(0)
  })

  it('a cancelled order cannot be receipted', async () => {
    await reportFailure(async () => ({ paid: false }))
    await expect(issueReceiptForOrder(ORDER)).rejects.toThrow(/not reached final paid state/)
    expect(receipts()).toHaveLength(0)
  })
})
