/**
 * THE CUSTOMER INVOICE IS THE FINANCIAL PROJECTION, WRITTEN DOWN -- Sprint 2026-09-28 brief.
 *
 * ================================================================================================
 * WHAT THESE TESTS DEFEND
 * ================================================================================================
 *
 * The first invoice engine billed `orders.items` as stored and checked the document against
 * `orders.total`. Both include voided lines (amend_order_lines never rewrites the original order),
 * so an amended tab was invoiced for food taken off the bill, and a reduced line twice. And every
 * invoice said `balance = total`, including one for a tab the customer had already paid.
 *
 * Each block below reconciles the invoice against three independent readings of the same money:
 *
 *   1. the projection        computeTabFinancials / computeOrderFinancials over the SAME rows
 *   2. the payment ledger     payment_events.amount for the settlement
 *   3. the allocated orders   Σ of the orders' own recorded charges
 *
 * and asserts the document's total, amount paid and outstanding equal them to the cent.
 *
 * Fixtures mirror the real incidents: the Riviera N$220 + N$500 = N$720 settlement
 * (supabase/tests/settlement-rpc.test.sql _seed_riviera) and Riviera order #160 with its three
 * reductions and the Modena void (the web-fin regression walk-through).
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'
import { extractPdfText } from './helpers/extract-pdf-text'
import {
  createInvoiceFromOrder,
  createInvoiceFromTab,
} from '@/lib/documents/create-invoice-from-order'
import { generateDocumentPdfBytes } from '@/lib/documents/generate-document-pdf'
import { toBusinessDocumentRow } from '@/lib/documents/business-document-row'
import { computeTabFinancials, type FinancialLineInput } from '@/lib/orders/order-financials'

const RESTAURANT_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '55555555-5555-4555-8555-555555555555'
const VAT_ID = testUuid('ab01')

type Row = Record<string, unknown>

/** One priced item, the shape calculateOrderPricing stores. */
function item(name: string, quantity: number, total: number, extra: Row = {}): Row {
  return {
    name,
    quantity,
    unitPrice: Math.round((total / quantity) * 100) / 100,
    total,
    taxRateId: VAT_ID,
    ...extra,
  }
}

function order(id: string, number: number, items: Row[], extra: Row = {}): Row {
  return {
    id,
    restaurant_id: RESTAURANT_ID,
    tab_id: TAB_ID,
    order_number: number,
    status: 'pending',
    payment_status: 'pending',
    payment_method: null,
    payment_reference: null,
    total: Math.round(items.reduce((s, i) => s + Number(i.total), 0) * 100) / 100,
    items,
    placed_at: `2026-09-24T18:${String(number % 60).padStart(2, '0')}:00.000Z`,
    table_number: 1,
    requires_reacceptance: false,
    tab_settlement_for_tab_id: null,
    ...extra,
  }
}

/** One order_lines row per item, every station in `state`. */
function linesFor(o: Row, state: string | ((index: number) => string)): Row[] {
  return (o.items as Row[]).map((_, index) => ({
    id: testUuid('ab02'),
    order_id: o.id,
    source_item_index: index,
    kitchen_state: typeof state === 'function' ? state(index) : state,
    bar_state: null,
  }))
}

let rpcCalls: string[]

function makeDb(seed: { orders: Row[]; lines?: Row[]; tables?: Record<string, Row[]> }) {
  const db = new InMemoryDb(
    {
      restaurants: [{ id: RESTAURANT_ID, name: 'Riviera', phone: '+264 61 000000', address: '1 Sam Nujoma', logo_url: null }],
      tax_rates: [
        { id: VAT_ID, restaurant_id: RESTAURANT_ID, name: 'VAT', percentage: 15, is_inclusive: true, is_default: true },
      ],
      restaurant_billing_profiles: [
        {
          restaurant_id: RESTAURANT_ID,
          registration_number: 'CC/2026/0001',
          vat_number: 'VAT-778899',
          bank_name: 'Bank Windhoek',
          bank_account_name: 'Riviera CC',
          bank_account_number: '8009112233',
          bank_branch_code: '481972',
        },
      ],
      tabs: [{ id: TAB_ID, restaurant_id: RESTAURANT_ID, table_number: 1, status: 'open' }],
      orders: seed.orders,
      order_lines: seed.lines ?? [],
      business_documents: [],
      document_payments: [],
      payment_events: [],
      order_line_allocations: [],
      order_line_allocation_settlements: [],
      ...(seed.tables ?? {}),
    },
    {
      business_documents: {
        defaults: { issued_at: '2026-09-28T08:00:00.000Z', currency: 'NAD', status: 'draft', sent_at: null },
      },
    },
  )
  rpcCalls = []
  let sequence = 0
  const base = db.client()
  const client = {
    ...base,
    async rpc(name: string) {
      rpcCalls.push(name)
      if (name === 'get_next_document_number') {
        sequence += 1
        return { data: 1000 + sequence, error: null }
      }
      return { data: null, error: { message: `unstubbed rpc ${name}` } }
    },
  } as unknown as Parameters<typeof createInvoiceFromTab>[0]
  return { db, client }
}

const tabInvoice = (client: Parameters<typeof createInvoiceFromTab>[0], billTo: Row = {}) =>
  createInvoiceFromTab(client, { tabId: TAB_ID, restaurantId: RESTAURANT_ID, createdBy: USER_ID, billTo })
const orderInvoice = (client: Parameters<typeof createInvoiceFromOrder>[0], orderId: string) =>
  createInvoiceFromOrder(client, { orderId, restaurantId: RESTAURANT_ID, createdBy: USER_ID })

/** The projection over exactly the rows the invoice read -- the reconciliation's first reading. */
function projectionOf(db: InMemoryDb, settled: Map<string, number> = new Map()) {
  return computeTabFinancials(
    db.rows('orders').filter((o) => o.tab_id === TAB_ID) as never,
    db.rows('order_lines') as unknown as FinancialLineInput[],
    settled,
  )
}

const cents = (value: unknown) => Math.round(Number(value) * 100)

function ok(result: Awaited<ReturnType<typeof createInvoiceFromTab>>) {
  if (!result.ok) throw new Error(`expected an invoice, got ${result.code}: ${result.message}`)
  return result.document as Row
}

async function pdfText(db: InMemoryDb, document: Row) {
  const payments = db
    .rows('document_payments')
    .filter((p) => p.document_id === document.id)
    .map((p) => ({ amount: Number(p.amount), method: String(p.method), reference: (p.reference as string) ?? null, paid_at: (p.paid_at as string) ?? null }))
  const bytes = await generateDocumentPdfBytes(toBusinessDocumentRow(document, undefined, { payments }))
  return (await extractPdfText(bytes)).replace(/\s+/g, ' ')
}

// ================================================================================================
// THE N$220 + N$500 = N$720 SETTLEMENT
// ================================================================================================

const O154 = 'aaaaaaaa-0000-4000-8000-000000000154'
const O155 = 'aaaaaaaa-0000-4000-8000-000000000155'

function riviera720(opts: { recorded?: boolean } = {}) {
  const recorded = opts.recorded ?? true
  const paid = (charge: number) => ({
    payment_status: 'paid',
    payment_method: 'card',
    payment_reference: 'MO-RIV-1',
    paid_at: '2026-09-24T21:00:00.000Z',
    ...(recorded ? { settled_charge_cents: charge } : {}),
  })
  const o154 = order(O154, 154, [item('Double Cheese Burger', 2, 180), item('Soft Drinks', 1, 40)], paid(22000))
  const o155 = order(O155, 155, [item('Seared Salmon', 1, 460), item('Mixers', 1, 40)], paid(50000))
  return makeDb({
    orders: [o154, o155],
    tables: {
      payment_events: [
        {
          id: testUuid('ab03'),
          restaurant_id: RESTAURANT_ID,
          event_type: 'sale',
          amount: 720,
          order_ids: [O154, O155],
          transaction_id: 'TXN-RIV-1',
          business_order_no: 'MO-RIV-1',
          created_at: '2026-09-24T21:00:00.000Z',
        },
      ],
    },
  })
}

describe('THE N$220 + N$500 = N$720 SCENARIO: two orders, one payment_event', () => {
  test.each([
    ['recorded charge', true],
    ['legacy paid (no recorded charge)', false],
  ])('tab invoice (%s): total 720, paid 720, outstanding 0, PAID -- and it reconciles', async (_label, recorded) => {
    const { db, client } = riviera720({ recorded })
    const doc = ok(await tabInvoice(client))

    const projection = projectionOf(db)
    const event = db.rows('payment_events')[0]
    const allocated = db.rows('orders').reduce((s, o) => s + cents(o.total), 0)

    // Invoice total = projection live = projection paid = ledger amount = allocated orders.
    expect(cents(doc.total)).toBe(72000)
    expect(cents(doc.total)).toBe(projection.liveCents)
    expect(projection.paidCents).toBe(72000)
    expect(cents(event.amount)).toBe(projection.paidCents)
    expect(allocated).toBe(projection.paidCents)

    expect(cents(doc.balance)).toBe(0)
    expect(cents(doc.balance)).toBe(projection.outstandingCents)
    expect(doc.status).toBe('paid')
    expect(doc.tab_id).toBe(TAB_ID)
    expect(doc.order_ids).toEqual([O154, O155])
    expect(doc.order_id).toBeNull()

    // ONE payment line, for the one settlement: the orders' own figures grouped under the shared
    // reference -- never the event's 720 attributed to each order (which would record 1,440).
    const payments = db.rows('document_payments')
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: 720, method: 'card', reference: 'TXN-RIV-1', document_id: doc.id })
  })

  test('an ORDER invoice for #154 alone records N$220 paid, not the settlement\'s N$720', async () => {
    const { db, client } = riviera720()
    const doc = ok(await orderInvoice(client, O154))

    expect(cents(doc.total)).toBe(22000)
    expect(cents(doc.balance)).toBe(0)
    expect(doc.status).toBe('paid')
    const payments = db.rows('document_payments')
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: 220, method: 'card', reference: 'TXN-RIV-1' })
  })

  test('the PDF says PAID, shows amount paid, NOTHING outstanding, the card and its masked reference', async () => {
    const { db, client } = riviera720()
    const text = await pdfText(db, ok(await tabInvoice(client)))

    expect(text).toContain('TAX INVOICE') // positive control on the extraction
    expect(text).toContain('PAID')
    expect(text).not.toContain('UNPAID')
    expect(text).toContain('Amount paid NAD 720.00')
    expect(text).toContain('Amount outstanding NAD 0.00')
    expect(text).toContain('Payments received')
    expect(text).toContain('CARD *****IV-1')
    expect(text).not.toContain('TXN-RIV-1') // the raw gateway reference is never printed
    expect(text).toContain('orders #154, #155')
    // A paid invoice does not ask to be paid again.
    expect(text).not.toContain('Kindly make payment')
  })
})

// ================================================================================================
// UNPAID, PARTIALLY PAID
// ================================================================================================

describe('unpaid and partially paid invoices', () => {
  const O1 = 'bbbbbbbb-0000-4000-8000-000000000001'

  test('UNPAID: total, nothing paid, everything outstanding, no payment rows', async () => {
    const o = order(O1, 301, [item('Seared Salmon', 1, 460)], { status: 'completed' })
    const { db, client } = makeDb({ orders: [o] })
    const doc = ok(await tabInvoice(client))

    expect(cents(doc.total)).toBe(46000)
    expect(cents(doc.balance)).toBe(46000)
    expect(cents(doc.balance)).toBe(projectionOf(db).outstandingCents)
    expect(doc.status).toBe('draft')
    expect(db.rows('document_payments')).toHaveLength(0)

    const text = await pdfText(db, doc)
    expect(text).toContain('UNPAID')
    expect(text).toContain('Amount paid NAD 0.00')
    expect(text).toContain('Amount outstanding NAD 460.00')
    expect(text).toContain('Kindly make payment')
  })

  test('PARTIALLY PAID through the item ledger: paid + outstanding = total, each equal to the projection', async () => {
    const o = order(O1, 302, [item('Seared Salmon', 1, 460), item('Hansa', 2, 160)])
    const allocationId = testUuid('ab04')
    const { db, client } = makeDb({
      orders: [o],
      lines: linesFor(o, 'ready'),
      tables: {
        order_line_allocations: [{ id: allocationId, order_id: O1, voided_at: null }],
        order_line_allocation_settlements: [
          { id: testUuid('ab05'), order_line_allocation_id: allocationId, amount_cents: 16000, method: 'cash', payment_reference: null, settled_at: '2026-09-24T20:00:00.000Z' },
        ],
      },
    })
    const doc = ok(await tabInvoice(client))
    const projection = projectionOf(db, new Map([[O1, 16000]]))

    expect(cents(doc.total)).toBe(62000)
    expect(projection.paidCents).toBe(16000)
    expect(cents(doc.balance)).toBe(projection.outstandingCents)
    expect(cents(doc.balance)).toBe(46000)
    expect(cents(doc.total) - cents(doc.balance)).toBe(projection.paidCents)
    expect(doc.status).toBe('partially_paid')
    expect(db.rows('document_payments')).toEqual([
      expect.objectContaining({ amount: 160, method: 'cash', reference: null }),
    ])

    const text = await pdfText(db, doc)
    expect(text).toContain('PARTIALLY PAID')
    expect(text).toContain('Amount paid NAD 160.00')
    expect(text).toContain('Amount outstanding NAD 460.00')
    expect(text).toContain('CASH')
  })
})

// ================================================================================================
// RIVIERA #160: AMENDED, AND MODENA CANCELLED
// ================================================================================================

const R160 = 'cccccccc-0000-4000-8000-000000000160'
const R161 = 'cccccccc-0000-4000-8000-000000000161'
const R162 = 'cccccccc-0000-4000-8000-000000000162'
const R163 = 'cccccccc-0000-4000-8000-000000000163'

/**
 * #160 as placed (N$1,945), then amend_order_lines three times: Wish You Were Here 2→1, Double
 * Cheese Burger 2→1, Seared Salmon 2→1. Each voids the WHOLE original line and inserts a
 * replacement order carrying the surviving quantity. Everything live has left the pass ('ready').
 */
function riviera160(opts: { modena: 'voided' | 'ready' }) {
  const placed = order(R160, 160, [
    item('Modena Pasta', 1, 240),
    item('Wish You Were Here', 2, 380),
    item('Seared Salmon', 2, 920),
    item('Double Cheese Burger', 2, 180),
    item('Jameson', 1, 80),
    item('Hansa', 1, 80),
    item('Soft Drinks', 1, 35),
    item('Mixers', 1, 30),
  ])
  const voidedIndexes = new Set([1, 2, 3, ...(opts.modena === 'voided' ? [0] : [])])
  const lines = linesFor(placed, (i) => (voidedIndexes.has(i) ? 'voided' : 'ready'))
  const r1 = order(R161, 161, [item('Wish You Were Here', 1, 190)])
  const r2 = order(R162, 162, [item('Double Cheese Burger', 1, 90)])
  const r3 = order(R163, 163, [item('Seared Salmon', 1, 460)])
  return makeDb({
    orders: [placed, r1, r2, r3],
    lines: [...lines, ...linesFor(r1, 'ready'), ...linesFor(r2, 'ready'), ...linesFor(r3, 'ready')],
  })
}

describe('Riviera #160: an amended tab is invoiced for what is live, once', () => {
  test('voided WYWH/salmon/burger lines are not charged; the replacements are charged exactly once', async () => {
    const { db, client } = riviera160({ modena: 'ready' })
    const doc = ok(await tabInvoice(client))
    const projection = projectionOf(db)

    expect(projection.liveCents).toBe(120500)
    expect(cents(doc.total)).toBe(120500)
    // The old engine's figure: Σ orders.total, every voided line still counted.
    expect(cents(doc.total)).not.toBe(194500 + 19000 + 9000 + 46000)
    expect(cents(doc.balance)).toBe(projection.outstandingCents)

    const lines = doc.line_items as Row[]
    const billed = (name: string) => lines.filter((l) => String(l.description) === name)
    expect(billed('Seared Salmon')).toEqual([expect.objectContaining({ quantity: 1, unit_price: 460, line_total: 460 })])
    expect(billed('Wish You Were Here')).toEqual([expect.objectContaining({ quantity: 1, line_total: 190 })])
    expect(billed('Double Cheese Burger')).toEqual([expect.objectContaining({ quantity: 1, line_total: 90 })])
    expect(lines.reduce((s, l) => s + cents(l.line_total), 0)).toBe(120500)

    const cancelled = doc.cancelled_line_items as Row[]
    expect(cancelled.map((c) => [c.description, c.quantity, c.line_total, c.reason, c.order_number])).toEqual([
      ['Wish You Were Here', 2, 380, 'voided', 160],
      ['Seared Salmon', 2, 920, 'voided', 160],
      ['Double Cheese Burger', 2, 180, 'voided', 160],
    ])
  })

  test('Modena CANCELLED: shown as cancelled, not in the total (tab drops by exactly N$240)', async () => {
    const { db, client } = riviera160({ modena: 'voided' })
    const doc = ok(await tabInvoice(client))

    expect(cents(doc.total)).toBe(96500)
    expect(cents(doc.total)).toBe(projectionOf(db).liveCents)
    expect((doc.line_items as Row[]).some((l) => String(l.description).includes('Modena'))).toBe(false)
    expect(doc.cancelled_line_items).toContainEqual(
      expect.objectContaining({ description: 'Modena Pasta', quantity: 1, line_total: 240, reason: 'voided' }),
    )

    const text = await pdfText(db, doc)
    // The extractor does not decode the WinAnsi em dash, so the heading is matched around it.
    expect(text).toMatch(/Cancelled .{0,2}not charged Qty Item Value Charged/)
    expect(text).toContain('Modena Pasta (voided · order #160)')
    expect(text).toContain('Total NAD 965.00')
  })

  test('the ORDER invoice for #160 alone bills only its surviving lines', async () => {
    const { client } = riviera160({ modena: 'ready' })
    const doc = ok(await orderInvoice(client, R160))
    expect(cents(doc.total)).toBe(46500)
    expect((doc.cancelled_line_items as Row[]).map((c) => c.description)).toEqual([
      'Wish You Were Here',
      'Seared Salmon',
      'Double Cheese Burger',
    ])
  })

  test('a whole cancelled order on the tab is listed as cancelled and charges nothing', async () => {
    const kept = order(R160, 170, [item('Hansa', 1, 80)], { status: 'completed' })
    const gone = order(R161, 171, [item('Modena Pasta', 1, 240)], { status: 'cancelled', payment_status: 'cancelled' })
    const { client } = makeDb({ orders: [kept, gone] })
    const doc = ok(await tabInvoice(client))
    expect(cents(doc.total)).toBe(8000)
    expect(doc.cancelled_line_items).toEqual([
      expect.objectContaining({ description: 'Modena Pasta', reason: 'order_cancelled', order_number: 171 }),
    ])
  })
})

// ================================================================================================
// VARIANTS, MULTI-ORDER, SETTLEMENT ARTEFACTS
// ================================================================================================

describe('what the lines say', () => {
  test('a variant selection is on the line with its price, and never doubled', async () => {
    const o = order('dddddddd-0000-4000-8000-000000000001', 401, [
      item('Flat White', 1, 42, { selectedVariants: { Size: 'Large' } }),
      item('Cappuccino', 2, 76, { displayName: 'Cappuccino - Regular', selectedVariants: { Size: 'Regular' } }),
    ], { status: 'completed' })
    const { client } = makeDb({ orders: [o] })
    const doc = ok(await tabInvoice(client))
    expect((doc.line_items as Row[]).map((l) => [l.description, l.quantity, l.unit_price])).toEqual([
      ['Flat White - Large', 1, 42],
      ['Cappuccino - Regular', 2, 38],
    ])
  })

  test('a multi-order tab: card, cash and unpaid rounds -- two payment lines, the unpaid round outstanding', async () => {
    const A = 'eeeeeeee-0000-4000-8000-00000000000a'
    const B = 'eeeeeeee-0000-4000-8000-00000000000b'
    const C = 'eeeeeeee-0000-4000-8000-00000000000c'
    const { db, client } = makeDb({
      orders: [
        order(A, 501, [item('Hansa', 2, 160)], { payment_status: 'paid', payment_method: 'card', payment_reference: 'REF-AAAA1111', settled_charge_cents: 16000 }),
        order(B, 502, [item('Jameson', 1, 80)], { payment_status: 'paid', payment_method: 'cash', settled_charge_cents: 8000 }),
        order(C, 503, [item('Seared Salmon', 1, 460)], { status: 'completed' }),
        // The row a tab settlement leaves behind. It records a payment, not food.
        order(testUuid('ab06'), 504, [item('Tab settlement', 1, 700)], { tab_settlement_for_tab_id: TAB_ID, payment_status: 'paid' }),
      ],
    })
    const doc = ok(await tabInvoice(client))
    const projection = projectionOf(db)

    expect(cents(doc.total)).toBe(70000)
    expect(cents(doc.total)).toBe(projection.liveCents)
    expect(cents(doc.balance)).toBe(46000)
    expect(cents(doc.balance)).toBe(projection.outstandingCents)
    expect(doc.status).toBe('partially_paid')
    expect(doc.order_ids).toEqual([A, B, C])
    expect((doc.line_items as Row[]).some((l) => String(l.description).includes('Tab settlement'))).toBe(false)
    expect(db.rows('document_payments').map((p) => [p.method, p.reference, p.amount])).toEqual(
      expect.arrayContaining([
        ['card', 'REF-AAAA1111', 160],
        ['cash', null, 80],
      ]),
    )
    expect(db.rows('document_payments')).toHaveLength(2)
  })
})

// ================================================================================================
// ELIGIBILITY, UNIQUENESS, MONEY SAFETY
// ================================================================================================

describe('eligibility and one live invoice per order/tab', () => {
  const O1 = 'ffffffff-0000-4000-8000-000000000001'
  const O2 = 'ffffffff-0000-4000-8000-000000000002'

  test('a tab with an item nobody has started is refused, and no number is burned', async () => {
    const o = order(O1, 601, [item('Hansa', 1, 80), item('Seared Salmon', 1, 460)])
    const { db, client } = makeDb({ orders: [o], lines: linesFor(o, (i) => (i === 0 ? 'ready' : 'outstanding')) })
    const result = await tabInvoice(client)
    expect(result).toMatchObject({ ok: false, code: 'ORDER_NOT_FINAL' })
    expect(rpcCalls).toHaveLength(0)
    expect(db.rows('business_documents')).toHaveLength(0)
  })

  test('OVERPAID (a void after a legacy whole-order charge) is refused: that is a refund', async () => {
    const o = order(O1, 602, [item('Hansa', 1, 80), item('Seared Salmon', 1, 460)], {
      payment_status: 'paid',
      payment_method: 'card',
    })
    const { client } = makeDb({ orders: [o], lines: linesFor(o, (i) => (i === 0 ? 'ready' : 'voided')) })
    expect(await tabInvoice(client)).toMatchObject({ ok: false, code: 'OVERPAID' })
  })

  test('a card payment in flight is refused -- what was paid is not known yet', async () => {
    const o = order(O1, 603, [item('Hansa', 1, 80)], { status: 'completed', payment_status: 'terminal_pending' })
    const { client } = makeDb({ orders: [o] })
    expect(await tabInvoice(client)).toMatchObject({ ok: false, code: 'PAYMENT_UNRESOLVED' })
  })

  test('a second tab invoice is refused; so is an order invoice for an order the tab invoice covers', async () => {
    const { db, client } = riviera720()
    const first = ok(await tabInvoice(client))

    expect(await tabInvoice(client)).toMatchObject({
      ok: false,
      code: 'INVOICE_ALREADY_EXISTS',
      existingDocument: { id: first.id },
    })
    expect(await orderInvoice(client, O155)).toMatchObject({ ok: false, code: 'INVOICE_ALREADY_EXISTS' })
    expect(db.rows('business_documents')).toHaveLength(1)
  })

  test('a tab invoice is refused while one of its orders has its own live invoice', async () => {
    const { client } = riviera720()
    ok(await orderInvoice(client, O154))
    expect(await tabInvoice(client)).toMatchObject({ ok: false, code: 'INVOICE_ALREADY_EXISTS' })
  })

  test('a VOIDED tab invoice does not block a new one -- that is what a correction leaves behind', async () => {
    const { db, client } = riviera720()
    ok(await tabInvoice(client))
    db.rows('business_documents')[0].status = 'void'
    expect((await tabInvoice(client)).ok).toBe(true)
  })

  test('a round added after the tab invoice is a new order the invoice does not cover', async () => {
    const o1 = order(O1, 604, [item('Hansa', 1, 80)], { status: 'completed' })
    const { db, client } = makeDb({ orders: [o1] })
    ok(await tabInvoice(client))
    db.rows('orders').push(order(O2, 605, [item('Jameson', 1, 80)], { status: 'completed' }))

    // The tab is invoiced (refused), but the new round is not on any invoice and can be billed.
    expect(await tabInvoice(client)).toMatchObject({ ok: false, code: 'INVOICE_ALREADY_EXISTS' })
    expect((await orderInvoice(client, O2)).ok).toBe(true)
  })

  test('another venue\'s tab reads as not found', async () => {
    const { client } = riviera720()
    const result = await createInvoiceFromTab(client, {
      tabId: TAB_ID,
      restaurantId: '99999999-9999-4999-8999-999999999999',
      createdBy: USER_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'TAB_NOT_FOUND' })
  })
})

describe('an invoice moves no money', () => {
  test('orders untouched; no payment, event, intent, settlement or tip row; only the numbering RPC', async () => {
    const { db, client } = riviera720()
    const before = JSON.stringify(db.rows('orders'))
    const eventsBefore = db.rows('payment_events').length

    ok(await tabInvoice(client))

    expect(JSON.stringify(db.rows('orders'))).toBe(before)
    expect(db.rows('payment_events')).toHaveLength(eventsBefore)
    for (const table of ['payments', 'terminal_payment_intents', 'order_line_allocation_settlements', 'payment_tips']) {
      expect(db.rows(table)).toHaveLength(0)
    }
    expect(rpcCalls).toEqual(['get_next_document_number'])
  })
})
