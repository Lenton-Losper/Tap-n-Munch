/**
 * Raising a FORMAL INVOICE from an order is a DOCUMENT operation and nothing else.
 *
 * ================================================================================================
 * WHAT THESE TESTS DEFEND
 * ================================================================================================
 *
 * 1. NO MONEY MOVES. No gateway call, no payment row, no intent, no settlement, and
 *    `orders.payment_status` / `orders.status` are exactly as they were. An invoice is a claim that
 *    money is owed; it is not a collection of it, and the moment the two are joined every guard on
 *    the payment path has to be restated here and one of them will be missed.
 *
 * 2. THE SERVER OWNS EVERY FIGURE. A caller supplies an order id. Descriptions, quantities, unit
 *    prices, tax rates and the total are read off the order row. A client-supplied total, line item
 *    or restaurant id changes nothing.
 *
 * 3. AN INCOMPLETE MERCHANT FAILS CLOSED, and does so BEFORE the numbering RPC runs -- a refusal
 *    after the sequence advanced would leave a gap in gapless numbering for a document that was
 *    never issued.
 *
 * 4. VAT IS REPRODUCED AND THEN CHECKED. The document total must equal the order total to the cent
 *    or the document is voided rather than issued. 289 of 4,463 paid production orders have a line
 *    with no taxRateId and would otherwise be re-taxed at whatever today's default rate is.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'
import {
  createInvoiceFromOrder,
  orderLinesToInvoiceLines,
  requiredBillingFieldsFor,
} from '@/lib/documents/create-invoice-from-order'

const RESTAURANT_ID = testUuid('aa01')
const OTHER_RESTAURANT_ID = testUuid('aa02')
const ORDER_ID = testUuid('aa03')
const USER_ID = testUuid('aa04')
const VAT_RATE_ID = testUuid('aa05')

/** Two lines at 15% VAT-inclusive, exactly the shape production stores (Chownow Nedbank #640). */
const ORDER_ITEMS = [
  {
    name: 'Salad with ribs',
    quantity: 1,
    unitPrice: 60,
    basePrice: 60,
    subtotal: 52.17,
    tax: 7.83,
    total: 60,
    taxRateId: VAT_RATE_ID,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
  {
    name: 'Can Juice',
    quantity: 1,
    unitPrice: 18,
    basePrice: 18,
    subtotal: 15.65,
    tax: 2.35,
    total: 18,
    taxRateId: VAT_RATE_ID,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
]

const FULL_BILLING = {
  restaurant_id: RESTAURANT_ID,
  registration_number: 'CC/2026/0001',
  vat_number: 'VAT-778899',
  bank_name: 'Bank Windhoek',
}

type Seed = {
  order?: Record<string, unknown>
  billing?: Record<string, unknown> | null
  documents?: Record<string, unknown>[]
  paymentEvents?: Record<string, unknown>[]
}

let rpcCalls: Array<{ name: string; args: unknown }>

function makeDb(seed: Seed = {}) {
  const db = new InMemoryDb({
    restaurants: [
      { id: RESTAURANT_ID, name: 'Riviera', phone: '+264 61 000000', address: '1 Sam Nujoma', logo_url: null },
      { id: OTHER_RESTAURANT_ID, name: 'Other Venue', phone: null, address: null, logo_url: null },
    ],
    tax_rates: [
      { id: VAT_RATE_ID, restaurant_id: RESTAURANT_ID, name: 'VAT', percentage: 15, is_inclusive: true, is_default: true },
    ],
    restaurant_billing_profiles: seed.billing === null ? [] : [{ ...FULL_BILLING, ...(seed.billing ?? {}) }],
    orders: [
      {
        id: ORDER_ID,
        restaurant_id: RESTAURANT_ID,
        order_number: 640,
        status: 'completed',
        payment_status: 'paid',
        total: 78,
        items: ORDER_ITEMS,
        placed_at: '2026-09-01T10:00:00.000Z',
        table_number: 4,
        customer_name: null,
        requires_reacceptance: false,
        ...(seed.order ?? {}),
      },
    ],
    business_documents: seed.documents ?? [],
    payment_events: seed.paymentEvents ?? [],
  })

  rpcCalls = []
  let sequence = 0
  const base = db.client()
  const client = {
    ...base,
    async rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args })
      if (name === 'get_next_document_number') {
        sequence += 1
        return { data: sequence, error: null }
      }
      return { data: null, error: { message: `unstubbed rpc ${name}` } }
    },
  }
  return { db, client: client as unknown as Parameters<typeof createInvoiceFromOrder>[0] }
}

const run = (client: Parameters<typeof createInvoiceFromOrder>[0], overrides = {}) =>
  createInvoiceFromOrder(client, {
    orderId: ORDER_ID,
    restaurantId: RESTAURANT_ID,
    createdBy: USER_ID,
    ...overrides,
  })

// ── pure mapping ─────────────────────────────────────────────────────────────

describe('order lines -> invoice lines', () => {
  test('carries name, quantity, unit price and tax rate across', () => {
    expect(orderLinesToInvoiceLines(ORDER_ITEMS)).toEqual([
      { description: 'Salad with ribs', quantity: 1, unit_price: 60, tax_rate_id: VAT_RATE_ID },
      { description: 'Can Juice', quantity: 1, unit_price: 18, tax_rate_id: VAT_RATE_ID },
    ])
  })

  test('a line with no name is still billed, never dropped', () => {
    const [line] = orderLinesToInvoiceLines([{ quantity: 2, unitPrice: 5 }])
    expect(line).toEqual({ description: 'Item', quantity: 2, unit_price: 5, tax_rate_id: null })
  })

  test('junk lines are skipped rather than priced as zero', () => {
    expect(orderLinesToInvoiceLines([null, 'x', { quantity: 0, unitPrice: 5 }, { quantity: 1 }])).toEqual([])
  })

  test('a non-array items column yields no lines rather than throwing', () => {
    expect(orderLinesToInvoiceLines(null)).toEqual([])
  })

  test('vat_number is required only when the sale carried VAT', () => {
    expect(requiredBillingFieldsFor(true)).toEqual(['registration_number', 'vat_number'])
    expect(requiredBillingFieldsFor(false)).toEqual(['registration_number'])
  })
})

// ── the happy path ───────────────────────────────────────────────────────────

describe('a completed, paid order', () => {
  test('produces an invoice whose totals equal the order', async () => {
    const { db, client } = makeDb()
    const result = await run(client)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const doc = result.document as Record<string, unknown>
    expect(doc.document_type).toBe('invoice')
    expect(doc.total).toBe(78)
    // 15% inclusive backed out of 78.00 -> 67.83 + 10.17. The order stored 67.82 + 10.18 because it
    // rounds per line; both reconcile to the same gross, which is the figure that must match.
    expect(Number(doc.subtotal) + Number(doc.vat_amount)).toBeCloseTo(78, 2)
    expect(doc.order_id).toBe(ORDER_ID)
    expect(doc.restaurant_id).toBe(RESTAURANT_ID)
  })

  test('snapshots the merchant details from Settings', async () => {
    const { client } = makeDb()
    const result = await run(client)
    if (!result.ok) throw new Error('expected ok')

    const doc = result.document as Record<string, unknown>
    expect(doc.business_name).toBe('Riviera')
    expect(doc.registration_number).toBe('CC/2026/0001')
    expect(doc.vat_number).toBe('VAT-778899')
    expect(doc.bank_name).toBe('Bank Windhoek')
    expect(doc.address).toBe('1 Sam Nujoma')
  })

  test('uses the existing gapless numbering RPC exactly once', async () => {
    const { client } = makeDb()
    await run(client)

    const numbering = rpcCalls.filter((c) => c.name === 'get_next_document_number')
    expect(numbering).toHaveLength(1)
    expect(numbering[0].args).toMatchObject({
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'invoice',
    })
  })

  test('records the order as the reference note', async () => {
    const { client } = makeDb()
    const result = await run(client)
    if (!result.ok) throw new Error('expected ok')
    expect(String((result.document as { reference_note: string }).reference_note)).toContain('#640')
  })
})

// ── MONEY SAFETY ─────────────────────────────────────────────────────────────

describe('creating an invoice moves no money', () => {
  test('the order is byte-identical afterwards', async () => {
    const { db, client } = makeDb()
    const before = JSON.stringify(db.rows('orders')[0])

    await run(client)

    expect(JSON.stringify(db.rows('orders')[0])).toBe(before)
  })

  test('an UNPAID order stays unpaid', async () => {
    const { db, client } = makeDb({ order: { payment_status: 'pending' } })

    const result = await run(client)

    expect(result.ok).toBe(true)
    expect(db.rows('orders')[0].payment_status).toBe('pending')
    expect(db.rows('orders')[0].status).toBe('completed')
  })

  test('no payment, intent, settlement or event row is created', async () => {
    const { db, client } = makeDb()
    await run(client)

    for (const table of [
      'payments',
      'payment_events',
      'terminal_payment_intents',
      'order_line_allocation_settlements',
      'payment_tips',
    ]) {
      expect(db.rows(table)).toHaveLength(0)
    }
  })

  test('the only RPC called is document numbering — never a gateway or settlement RPC', async () => {
    const { client } = makeDb()
    await run(client)
    expect(rpcCalls.map((c) => c.name)).toEqual(['get_next_document_number'])
  })
})

// ── ELIGIBILITY ──────────────────────────────────────────────────────────────

describe('eligibility', () => {
  test('a CANCELLED order is refused and no document is written', async () => {
    const { db, client } = makeDb({ order: { status: 'cancelled', payment_status: 'cancelled' } })

    const result = await run(client)

    expect(result).toMatchObject({ ok: false, code: 'ORDER_CANCELLED' })
    expect(db.rows('business_documents')).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })

  test.each(['pending', 'preparing', 'ready', 'confirmed'])(
    'an in-flight order (%s) is refused — its total can still change',
    async (status) => {
      const { db, client } = makeDb({ order: { status } })

      const result = await run(client)

      expect(result).toMatchObject({ ok: false, code: 'ORDER_NOT_FINAL' })
      expect(db.rows('business_documents')).toHaveLength(0)
    },
  )

  test('an order awaiting re-acceptance is refused', async () => {
    const { client } = makeDb({ order: { requires_reacceptance: true } })
    expect(await run(client)).toMatchObject({ ok: false, code: 'ORDER_AWAITING_REACCEPTANCE' })
  })

  test('an order with no priced lines is refused', async () => {
    const { client } = makeDb({ order: { items: [] } })
    expect(await run(client)).toMatchObject({ ok: false, code: 'ORDER_HAS_NO_LINES' })
  })

  test('an order with a zero total is refused', async () => {
    const { client } = makeDb({ order: { total: 0, items: [{ name: 'x', quantity: 1, unitPrice: 0 }] } })
    expect(await run(client)).toMatchObject({ ok: false, code: 'ORDER_TOTAL_UNUSABLE' })
  })
})

// ── MERCHANT DETAILS ─────────────────────────────────────────────────────────

describe('incomplete merchant details fail closed', () => {
  test('no billing profile at all is refused, naming what is missing', async () => {
    const { db, client } = makeDb({ billing: null })

    const result = await run(client)

    expect(result).toMatchObject({ ok: false, code: 'BILLING_PROFILE_INCOMPLETE' })
    if (result.ok) return
    expect(result.missingBillingFields).toEqual(['registration_number', 'vat_number'])
    expect(result.message).toMatch(/Settings/)
  })

  test('a VAT-charging sale with no VAT number is refused', async () => {
    const { client } = makeDb({ billing: { vat_number: null } })

    const result = await run(client)
    expect(result).toMatchObject({ ok: false, code: 'BILLING_PROFILE_INCOMPLETE' })
    if (!result.ok) expect(result.missingBillingFields).toEqual(['vat_number'])
  })

  test('a sale with NO VAT at all does not require a VAT number', async () => {
    /**
     * A line with no `taxRateId` still resolves to the venue's DEFAULT rate -- that is the shared
     * hierarchy order pricing uses. So "no VAT" means a venue with no tax rates configured, not
     * merely a line that names none. Both halves matter: the first is the 289-production-order
     * case, which DOES carry VAT and must demand a VAT number.
     */
    const { db, client } = makeDb({
      billing: { vat_number: null },
      order: { total: 10, items: [{ name: 'Water', quantity: 1, unitPrice: 10, taxRateId: null }] },
    })
    db.rows('tax_rates').length = 0

    const result = await run(client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.document as { vat_amount: number }).vat_amount).toBe(0)
    expect((result.document as { total: number }).total).toBe(10)
  })

  test('a line with no taxRateId still falls back to the default rate and DOES need a VAT number', async () => {
    const { client } = makeDb({
      billing: { vat_number: null },
      order: { total: 10, items: [{ name: 'Water', quantity: 1, unitPrice: 10, taxRateId: null }] },
    })

    const result = await run(client)
    expect(result).toMatchObject({ ok: false, code: 'BILLING_PROFILE_INCOMPLETE' })
    if (!result.ok) expect(result.missingBillingFields).toEqual(['vat_number'])
  })

  test('NO DOCUMENT NUMBER IS BURNED by a refusal', async () => {
    const { db, client } = makeDb({ billing: null })

    await run(client)

    // The sequence must be untouched: a refused invoice that consumed a number leaves a
    // permanent gap in numbering that is supposed to be gapless.
    expect(rpcCalls.filter((c) => c.name === 'get_next_document_number')).toHaveLength(0)
    expect(db.rows('business_documents')).toHaveLength(0)
  })
})

// ── DUPLICATES AND LINEAGE ───────────────────────────────────────────────────

describe('duplicates and lineage', () => {
  test('a second invoice for the same order is refused, naming the first', async () => {
    const { db, client } = makeDb()
    const first = await run(client)
    expect(first.ok).toBe(true)

    const second = await run(client)

    expect(second).toMatchObject({ ok: false, code: 'INVOICE_ALREADY_EXISTS' })
    if (!second.ok) expect(second.existingDocument?.document_number).toBe('1')
    expect(db.rows('business_documents')).toHaveLength(1)
  })

  test('a VOIDED invoice does not block a replacement — that is what a correction leaves behind', async () => {
    const { db, client } = makeDb({
      documents: [
        {
          id: testUuid('aa06'),
          restaurant_id: RESTAURANT_ID,
          order_id: ORDER_ID,
          document_type: 'invoice',
          document_number: '7',
          status: 'void',
        },
      ],
    })

    const result = await run(client)
    expect(result.ok).toBe(true)
  })

  test('a credit note against the order does not count as an existing invoice', async () => {
    const { client } = makeDb({
      documents: [
        {
          id: testUuid('aa07'),
          restaurant_id: RESTAURANT_ID,
          order_id: ORDER_ID,
          document_type: 'credit_note',
          document_number: '2',
          status: 'issued',
        },
      ],
    })

    expect((await run(client)).ok).toBe(true)
  })

  test("another venue's invoice for a colliding order id does not block this one", async () => {
    const { client } = makeDb({
      documents: [
        {
          id: testUuid('aa08'),
          restaurant_id: OTHER_RESTAURANT_ID,
          order_id: ORDER_ID,
          document_type: 'invoice',
          document_number: '9',
          status: 'sent',
        },
      ],
    })

    expect((await run(client)).ok).toBe(true)
  })
})

// ── SECURITY ─────────────────────────────────────────────────────────────────

describe('restaurant isolation', () => {
  test("an order at another venue reads as NOT FOUND, not as forbidden", async () => {
    const { db, client } = makeDb()

    const result = await createInvoiceFromOrder(client, {
      orderId: ORDER_ID,
      restaurantId: OTHER_RESTAURANT_ID,
      createdBy: USER_ID,
    })

    // Same answer as a non-existent id: distinguishing them lets a caller enumerate order ids.
    expect(result).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND' })
    expect(db.rows('business_documents')).toHaveLength(0)
  })

  test('an arbitrary order id is refused', async () => {
    const { client } = makeDb()
    const result = await createInvoiceFromOrder(client, {
      orderId: testUuid('aa09'),
      restaurantId: RESTAURANT_ID,
      createdBy: USER_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND' })
  })

  test('the document is written against the AUTHORIZED restaurant', async () => {
    const { db, client } = makeDb()
    await run(client)
    expect(db.rows('business_documents')[0].restaurant_id).toBe(RESTAURANT_ID)
  })
})

// ── TOTALS MUST AGREE ────────────────────────────────────────────────────────

describe('a document that disagrees with the order is not issued', () => {
  test("a venue that changed its VAT rate since the sale gets a refusal, not a wrong invoice", async () => {
    // The order was sold at 15% inclusive; the line carries no rate id, so it falls back to the
    // venue's default -- which is now EXCLUSIVE, adding tax on top instead of backing it out.
    const { db, client } = makeDb({
      order: {
        total: 78,
        items: [{ name: 'Meal', quantity: 1, unitPrice: 78, taxRateId: null }],
      },
    })
    db.rows('tax_rates')[0].is_inclusive = false

    const result = await run(client)

    expect(result).toMatchObject({ ok: false, code: 'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER' })
    // Voided, not deleted: the ledger is append-only and its numbering is gapless.
    expect(db.rows('business_documents')).toHaveLength(1)
    expect(db.rows('business_documents')[0].status).toBe('void')
  })
})
