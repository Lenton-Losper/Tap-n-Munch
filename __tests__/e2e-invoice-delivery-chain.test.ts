/**
 * THE INVOICE A CUSTOMER RECEIVES, READ OUT OF THE PDF THAT WAS ACTUALLY EMAILED (Phase 5).
 *
 * invoice-from-projection.test.ts proves the invoice ENGINE against hand-built rows and renders a
 * PDF beside it; document-send-actually-sends.test.ts proves the email path with the PDF renderer
 * mocked. Neither follows one invoice from the money rows to the bytes a customer opens. This does:
 *
 *   rows written by the REAL settle_order_payment / amend_order_lines (the recorded snapshot,
 *   ./helpers/modena-rpc-replay.ts) or by the REAL tab settle route
 *     -> POST /api/admin/documents/from-order     (createInvoiceFromTab / createInvoiceFromOrder)
 *     -> POST /api/admin/documents/[id]/send      (sendDocumentEmail -> generateDocumentPdfBytes)
 *     -> Resend, stopped at the NETWORK: global fetch is intercepted at api.resend.com and the
 *        request body the SDK built is read back -- the attachment is base64 PDF bytes, which are
 *        decoded and run through the text extractor
 *
 * and every figure is asserted on the extracted text as well as on the stored document.
 *
 * INVARIANTS, per case:
 *   invoice total        = the projection's live figure over the same rows
 *   paid invoice         invoice paid = ledger (payment_events.amount, less a recorded tip)
 *                                     = Σ settled_charge_cents (what the settlement applied)
 *   partial              outstanding = total − paid
 *
 * GRATUITIES (owner ruling 2026-09-05: a tip is never inside an order total). The invoice bills
 * food only: the tip is not a line, not in the subtotal/VAT/total, and not in "Amount paid". It is
 * recorded only in payment_tips. So on a tipped card payment the ledger row (what the card was
 * charged) EXCEEDS the invoice's amount paid by exactly the tip, and that is asserted as the
 * reconciliation: invoice paid + Σ payment_tips = ledger. On cash, the ledger (payments.amount) is
 * the food figure and the tip is again only in payment_tips.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { extractPdfText } from './helpers/extract-pdf-text'
import {
  MANAGER,
  O160,
  R,
  SNAP,
  TAB,
  applyState,
  seedModenaDb,
  type ModenaState,
} from './helpers/modena-rpc-replay'
import { computeTabFinancials, type FinancialLineInput, type FinancialOrderInput } from '@/lib/orders/order-financials'
import { maskPaymentReference } from '@/lib/documents/generate-document-pdf'

let mockDb: InMemoryDb

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: '11111111-1111-4111-8111-111111111111',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0160',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({ safeIssueReceiptsForOrders: async () => undefined }))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'staff-1' }),
  requireCallerRestaurantId: async (_s: unknown, _u: string, requested: string) => requested,
}))
jest.mock('@/lib/permissions/authorize', () => ({ requirePermission: async () => null }))
jest.mock('@/lib/supabase/client', () => ({
  supabase: new Proxy({}, { get: (_t, key) => (mockDb.client() as Record<string | symbol, unknown>)[key] }),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const base = mockDb.client()
    return {
      ...base,
      async rpc(name: string, args: unknown) {
        if (name === 'get_next_document_number') {
          return { data: 1042 + mockDb.rows('business_documents').length + 1, error: null }
        }
        return base.rpc(name, args)
      },
      from(table: string) {
        // The cash claim's .or(): every order it is used on here is pending.
        const q = base.from(table) as unknown as Record<string, unknown> & { in: (c: string, v: unknown[]) => unknown }
        q.or = (expr: string) => {
          const m = /^payment_status\.in\.\(([^)]*)\),/.exec(expr)
          if (!m) throw new Error(`unmodelled .or(${expr})`)
          return q.in('payment_status', m[1].split(','))
        }
        return q
      },
    }
  },
}))

import { POST as invoiceRoute } from '@/app/api/admin/documents/from-order/route'
import { POST as sendRoute } from '@/app/api/admin/documents/[id]/send/route'
import { POST as settleRoute } from '@/app/api/terminal/tabs/[tabId]/settle/route'

type Json = Record<string, any>

/** What left the building: every request the Resend SDK made, as the SDK serialised it. */
const outbound: Array<{ url: string; body: Json }> = []

beforeEach(() => {
  outbound.length = 0
  process.env.RESEND_API_KEY = 're_test_e2e'
  jest.spyOn(global, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://api.resend.com/')) throw new Error(`unexpected network call to ${url}`)
    outbound.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ id: `re_${outbound.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

/** The whole Modena branch, as the database wrote it: reductions, the void, the card settlement. */
function modenaSettled(): InMemoryDb {
  const db = seedModenaDb()
  for (const step of [...SNAP.reductions, ...SNAP.branch_a]) applyState(db, step.post)
  return db
}

/** Branch B (Modena refused), with every line the kitchen and bar still held moved to ready. */
function modenaRefusedServed(): InMemoryDb {
  const db = seedModenaDb()
  for (const step of SNAP.branch_b) applyState(db, step.post)
  for (const l of db.rows('order_lines')) {
    if (l.kitchen_state === 'outstanding') l.kitchen_state = 'ready'
    if (l.bar_state === 'outstanding') l.bar_state = 'ready'
  }
  return db
}

function from720(state: ModenaState): InMemoryDb {
  const db = seedModenaDb()
  db.tables.orders = []
  db.tables.order_lines = []
  applyState(db, state)
  return db
}

async function raiseInvoice(scope: { tab_id: string } | { order_id: string }) {
  const res = await invoiceRoute(
    new Request('https://x.test/api/admin/documents/from-order', {
      method: 'POST',
      body: JSON.stringify({ ...scope, restaurant_id: R, bill_to: { name: 'Acme CC', email: 'ap@acme.test' } }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function send(documentId: string) {
  const res = await sendRoute(new Request(`https://x.test/api/admin/documents/${documentId}/send`, { method: 'POST' }), {
    params: Promise.resolve({ id: documentId }),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

/** Raise the invoice, send it, and read the attachment the customer received. */
async function deliver(scope: { tab_id: string } | { order_id: string }) {
  const raised = await raiseInvoice(scope)
  if (raised.status !== 201) throw new Error(`invoice refused: ${JSON.stringify(raised.body)}`)
  const doc = raised.body.document as Json
  const sent = await send(String(doc.id))
  if (sent.status !== 200) throw new Error(`send refused (${sent.status}): ${JSON.stringify(sent.body)} doc ${doc.status}`)
  expect(outbound).toHaveLength(1)
  const email = outbound[0].body
  expect(email.to).toEqual(['ap@acme.test'])
  expect(email.attachments).toHaveLength(1)
  const attachment = email.attachments[0]
  expect(attachment.content_type).toBe('application/pdf')
  const bytes = Buffer.from(String(attachment.content), 'base64')
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  const text = (await extractPdfText(new Uint8Array(bytes))).replace(/\s+/g, ' ')
  return { doc, sent: sent.body, email, text }
}

const cents = (v: unknown) => Math.round(Number(v) * 100)
/** As the PDF prints money (thousands separated); the email body prints it without separators. */
const money = (c: number) =>
  `NAD ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const plain = (c: number) => `NAD ${(c / 100).toFixed(2)}`
const paidOnInvoice = () => mockDb.rows('document_payments').reduce((s, p) => s + cents(p.amount), 0)
function projection() {
  const orders = mockDb.rows('orders').filter((o) => o.tab_id === TAB) as unknown as FinancialOrderInput[]
  return computeTabFinancials(orders, mockDb.rows('order_lines') as unknown as FinancialLineInput[])
}

describe('FULLY PAID, AMENDED, WITH CANCELLED LINES -- Riviera #160 after the Modena void, paid by card', () => {
  it('total = live = N$965; paid = ledger = Σ settled charges; the PDF the customer got says so', async () => {
    mockDb = modenaSettled()
    const { doc, text, email, sent } = await deliver({ tab_id: TAB })

    // Invoice total = projection live; paid = ledger = allocated per-order charges.
    expect(cents(doc.total)).toBe(96500)
    expect(cents(doc.total)).toBe(projection().liveCents)
    expect(cents(doc.balance)).toBe(0)
    expect(doc.status).toBe('paid')
    const ledger = cents(mockDb.rows('payment_events')[0].amount)
    const settled = mockDb.rows('orders').reduce((s, o) => s + Number(o.settled_charge_cents), 0)
    expect(paidOnInvoice()).toBe(96500)
    expect(ledger).toBe(96500)
    expect(settled).toBe(96500)

    // Method and reference: one card payment, the gateway transaction masked to its last four.
    expect(mockDb.rows('document_payments')).toEqual([
      expect.objectContaining({ amount: 965, method: 'card', reference: 'TXN-MODENA-1' }),
    ])

    // VAT (15% inclusive) on what is billed, and nothing else.
    expect(cents(doc.subtotal) + cents(doc.vat_amount)).toBe(96500)
    expect(Math.abs(cents(doc.vat_amount) - Math.round((96500 * 15) / 115))).toBeLessThanOrEqual(1)

    expect(text).toContain('TAX INVOICE')
    expect(text).toContain('PAID')
    expect(text).not.toContain('UNPAID')
    expect(text).toContain(`Total ${money(96500)}`)
    expect(text).toContain(`VAT ${money(cents(doc.vat_amount))}`)
    expect(text).toContain(`Amount paid ${money(96500)}`)
    expect(text).toContain(`Amount outstanding ${money(0)}`)
    expect(text).toContain('Payments received')
    expect(text).toContain(`CARD ${maskPaymentReference('TXN-MODENA-1')}`)
    expect(text).not.toContain('TXN-MODENA-1')
    expect(text).not.toContain('Kindly make payment')

    // Cancelled -- not charged: the Modena void and the three reduced originals, never in the total.
    expect(text).toMatch(/Cancelled .{0,2}not charged/)
    expect(text).toContain('Modena Pasta (voided · order #160)')
    for (const name of ['Wish You Were Here', 'Seared Salmon', 'Double Cheese Burger']) {
      expect(text).toContain(`${name} (voided · order #160)`)
    }
    const billed = (doc.line_items as Json[]).map((l) => [l.description, l.quantity, l.line_total])
    expect(billed).not.toContainEqual(expect.arrayContaining(['Modena Pasta']))
    expect(billed.reduce((s, l) => s + cents(l[2]), 0)).toBe(96500)

    // The email body: the amount, and no "How to pay" on a paid invoice.
    expect(email.subject).toBe(`Invoice ${doc.document_number} from Riviera`)
    expect(email.html).toContain(plain(96500))
    expect(email.html).not.toContain('How to pay')
    // Sent, and still paid.
    expect(sent.document).toMatchObject({ status: 'paid' })
    expect(mockDb.rows('business_documents')[0].sent_at).not.toBeNull()
    expect(mockDb.rows('audit_logs').some((a) => a.action === 'document.emailed')).toBe(true)
  })

  it('an ORDER invoice for #160 alone: N$225 live, paid N$225 -- its own settled charge, not the N$965 ledger row', async () => {
    mockDb = modenaSettled()
    const { doc, text } = await deliver({ order_id: O160 })
    expect(cents(doc.total)).toBe(22500)
    expect(paidOnInvoice()).toBe(22500)
    expect(Number(mockDb.rows('orders').find((o) => o.id === O160)!.settled_charge_cents)).toBe(22500)
    expect(text).toContain(`Total ${money(22500)}`)
    expect(text).toContain(`Amount paid ${money(22500)}`)
  })
})

describe('UNPAID -- Modena refused, the table served, nothing paid', () => {
  it('total = live = N$1,205, all of it outstanding; the PDF and the email ask to be paid', async () => {
    mockDb = modenaRefusedServed()
    const { doc, text, email, sent } = await deliver({ tab_id: TAB })
    expect(cents(doc.total)).toBe(120500)
    expect(cents(doc.total)).toBe(projection().liveCents)
    expect(cents(doc.balance)).toBe(120500)
    expect(mockDb.rows('document_payments')).toHaveLength(0)
    expect(text).toContain('UNPAID')
    expect(text).toContain(`Amount paid ${money(0)}`)
    expect(text).toContain(`Amount outstanding ${money(120500)}`)
    expect(text).toContain('Kindly make payment')
    // Modena is BILLED (the void was refused); only the three reduced originals are cancelled.
    expect((doc.line_items as Json[]).map((l) => l.description)).toContain('Modena Pasta')
    expect(text).not.toContain('Modena Pasta (voided')
    expect(email.html).toContain('How to pay')
    expect(email.html).toContain('8009112233')
    expect(sent.document).toMatchObject({ status: 'sent' })
  })
})

describe('PARTIALLY PAID -- a guest paid their Jameson at the table (item ledger, cash)', () => {
  it('paid N$80, outstanding = total − paid = N$1,125, both on the PDF and in the email', async () => {
    mockDb = modenaRefusedServed()
    const jameson = mockDb.rows('order_lines').find((l) => l.name_snapshot === 'Jameson')!
    mockDb.rows('order_line_allocations').push({
      id: 'a110c000-0000-4000-8000-000000000001',
      restaurant_id: R,
      order_id: O160,
      order_line_id: jameson.id,
      tab_id: TAB,
      allocated_to: 'guest-1',
      quantity_allocated: 1,
      amount_cents: 8000,
      voided_at: null,
      settled_at: '2026-09-24T20:00:00.000Z',
    })
    mockDb.rows('order_line_allocation_settlements').push({
      id: 'a110c000-0000-4000-8000-000000000002',
      restaurant_id: R,
      order_line_allocation_id: 'a110c000-0000-4000-8000-000000000001',
      tab_id: TAB,
      amount_cents: 8000,
      method: 'cash',
      payment_reference: null,
      settled_at: '2026-09-24T20:00:00.000Z',
    })
    const { doc, text, email } = await deliver({ tab_id: TAB })
    expect(cents(doc.total)).toBe(120500)
    expect(paidOnInvoice()).toBe(8000)
    expect(cents(doc.balance)).toBe(cents(doc.total) - paidOnInvoice())
    expect(cents(doc.balance)).toBe(112500)
    expect(doc.status).toBe('partially_paid')
    expect(text).toContain('PARTIALLY PAID')
    expect(text).toContain(`Amount paid ${money(8000)}`)
    expect(text).toContain(`Amount outstanding ${money(112500)}`)
    expect(text).toContain('CASH')
    expect(email.html).toContain(plain(8000))
    expect(email.html).toContain(plain(112500))
  })
})

describe('THE N$220 + N$500 = N$720 SETTLEMENT, as settle_order_payment recorded it', () => {
  it('tab invoice: total 720, paid 720 = the ONE ledger row = Σ settled charges; ONE payment line, not two', async () => {
    mockDb = from720(SNAP.riviera_720.post)
    const { doc, text } = await deliver({ tab_id: TAB })
    expect(cents(doc.total)).toBe(72000)
    expect(paidOnInvoice()).toBe(72000)
    expect(mockDb.rows('payment_events').map((e) => cents(e.amount))).toEqual([72000])
    expect(mockDb.rows('orders').map((o) => o.settled_charge_cents).sort()).toEqual([22000, 50000])
    expect(mockDb.rows('document_payments')).toHaveLength(1)
    expect(text).toContain(`Total ${money(72000)}`)
    expect(text).toContain(`Amount paid ${money(72000)}`)
    expect(text).toContain('orders #154, #155')
    expect(text).toContain(`CARD ${maskPaymentReference('TXN-RIV-720')}`)
  })

  it('an order invoice for #154 alone records N$220 paid -- never the settlement\'s N$720', async () => {
    mockDb = from720(SNAP.riviera_720.post)
    const { doc, text } = await deliver({ order_id: 'eeeeeeee-0000-4000-8000-000000000154' })
    expect(cents(doc.total)).toBe(22000)
    expect(paidOnInvoice()).toBe(22000)
    expect(text).toContain(`Amount paid ${money(22000)}`)
    expect(text).not.toContain(money(72000))
  })
})

describe('GRATUITIES -- outside the invoice by construction (2026-09-05 ruling)', () => {
  it('CARD: N$750 charged (720 + 30 tip). The invoice bills and records N$720; paid + tip = ledger', async () => {
    mockDb = from720(SNAP.riviera_720_tip.post)
    const { doc, text, email } = await deliver({ tab_id: TAB })
    const ledger = cents(mockDb.rows('payment_events')[0].amount)
    const tips = mockDb.rows('payment_tips').reduce((s, t) => s + Number(t.tip_cents), 0)
    expect(ledger).toBe(75000)
    expect(tips).toBe(3000)
    expect(cents(doc.total)).toBe(72000)
    expect(cents(doc.subtotal) + cents(doc.vat_amount)).toBe(72000) // the tip is outside the VAT base
    expect(paidOnInvoice()).toBe(72000)
    expect(paidOnInvoice() + tips).toBe(ledger)
    expect(doc.status).toBe('paid')
    expect(text).toContain(`Total ${money(72000)}`)
    expect(text).toContain(`Amount paid ${money(72000)}`)
    expect(text).not.toContain(money(75000))
    expect(text).not.toMatch(/tip|gratuity/i)
    expect(email.html).not.toContain(plain(75000))
  })

  it('CASH through the tab settle route with a N$50 tip: payments row = food, tip only in payment_tips, invoice = food', async () => {
    mockDb = modenaRefusedServed()
    const ids = mockDb.rows('orders').filter((o) => o.tab_id === TAB).map((o) => String(o.id))
    const res = await settleRoute(
      new NextRequest(`http://localhost/api/terminal/tabs/${TAB}/settle`, {
        method: 'POST',
        body: JSON.stringify({ order_ids: ids, amount: 1205, method: 'cash', tip_cents: 5000, tip_staff_user_id: MANAGER }),
      }),
      { params: Promise.resolve({ tabId: TAB }) },
    )
    const settled = (await res.json()) as Json
    expect(res.status).toBe(200)
    expect(settled).toMatchObject({ tip_cents: 5000, tip_recorded: 'recorded' })
    expect(mockDb.rows('payments')).toEqual([expect.objectContaining({ amount: 1205, method: 'cash' })])
    expect(mockDb.rows('payment_tips')).toEqual([expect.objectContaining({ tip_cents: 5000, method: 'cash', staff_user_id: MANAGER })])

    const { doc, text } = await deliver({ tab_id: TAB })
    expect(cents(doc.total)).toBe(120500)
    expect(paidOnInvoice()).toBe(120500)
    expect(paidOnInvoice()).toBe(cents(mockDb.rows('payments')[0].amount))
    expect(cents(doc.balance)).toBe(0)
    expect(text).toContain(`Amount paid ${money(120500)}`)
    expect(text).toContain('CASH')
    expect(text).not.toMatch(/tip|gratuity/i)
    expect(text).not.toContain(money(125500))
  })
})
