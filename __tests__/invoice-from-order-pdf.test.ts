/**
 * End to end: a real order becomes a real invoice PDF, through the EXISTING renderer.
 *
 * The receipt renderer is deliberately not involved and must never be. A receipt is issued after
 * payment and snapshots the venue at issuance; an invoice is a demand for payment with its own
 * numbering, its own party block and its own totals block. They are separate documents with
 * separate rules, and lib/receipts/* is not imported here.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'
import { createInvoiceFromOrder } from '@/lib/documents/create-invoice-from-order'
import {
  generateDocumentPdfBytes,
  type BusinessDocumentRow,
} from '@/lib/documents/generate-document-pdf'

const RESTAURANT_ID = testUuid('pd01')
const ORDER_ID = testUuid('pd02')
const USER_ID = testUuid('pd03')
const VAT_RATE_ID = testUuid('pd04')

function makeClient() {
  const db = new InMemoryDb({
    restaurants: [
      {
        id: RESTAURANT_ID,
        name: 'Riviera Wine Shop',
        phone: '+264 61 123456',
        address: '12 Independence Ave, Windhoek',
        logo_url: null,
      },
    ],
    tax_rates: [
      {
        id: VAT_RATE_ID,
        restaurant_id: RESTAURANT_ID,
        name: 'VAT',
        percentage: 15,
        is_inclusive: true,
        is_default: true,
      },
    ],
    restaurant_billing_profiles: [
      {
        restaurant_id: RESTAURANT_ID,
        registration_number: 'CC/2026/04821',
        vat_number: '4820226018',
        bank_name: 'Bank Windhoek',
        bank_account_name: 'Riviera Wine Shop CC',
        bank_account_number: '8009 1122 33',
        bank_branch_code: '481972',
      },
    ],
    orders: [
      {
        id: ORDER_ID,
        restaurant_id: RESTAURANT_ID,
        order_number: 640,
        status: 'completed',
        payment_status: 'paid',
        total: 78,
        items: [
          { name: 'Salad with ribs', quantity: 1, unitPrice: 60, taxRateId: VAT_RATE_ID },
          { name: 'Can Juice', quantity: 1, unitPrice: 18, taxRateId: VAT_RATE_ID },
        ],
        placed_at: '2026-09-01T10:00:00.000Z',
        table_number: 4,
        customer_name: null,
        requires_reacceptance: false,
      },
    ],
    business_documents: [],
    payment_events: [],
  }, {
    /**
     * `issued_at timestamptz NOT NULL DEFAULT now()` and `currency text NOT NULL DEFAULT 'NAD'`,
     * exactly as 20260705280000 declares them. createBusinessDocument does not write either --
     * Postgres supplies both -- so without the defaults here the fake returns a row the real
     * database never would, and the renderer would be tested against a shape that cannot occur.
     */
    business_documents: { defaults: { issued_at: '2026-09-13T08:00:00.000Z', currency: 'NAD', status: 'draft' } },
  })

  const base = db.client()
  return {
    db,
    client: {
      ...base,
      async rpc(name: string) {
        if (name === 'get_next_document_number') return { data: 1043, error: null }
        return { data: null, error: { message: `unstubbed rpc ${name}` } }
      },
    } as unknown as Parameters<typeof createInvoiceFromOrder>[0],
  }
}

test('an order becomes a formal invoice PDF carrying every mandatory element', async () => {
  const { client } = makeClient()

  const result = await createInvoiceFromOrder(client, {
    orderId: ORDER_ID,
    restaurantId: RESTAURANT_ID,
    createdBy: USER_ID,
    billTo: { name: 'Acme Trading CC', email: 'ap@acme.test', address: 'PO Box 11, Windhoek' },
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return

  const doc = result.document as unknown as BusinessDocumentRow

  // ── the document row carries what a formal invoice must state ──────────────
  expect(doc.document_type).toBe('invoice')
  expect(doc.document_number).toBe('1043')
  expect(doc.issued_at).toBeTruthy()
  expect(doc.business_name).toBe('Riviera Wine Shop')
  expect(doc.registration_number).toBe('CC/2026/04821')
  expect(doc.vat_number).toBe('4820226018')
  expect(doc.address).toBe('12 Independence Ave, Windhoek')
  expect(doc.bank_account_number).toBe('8009 1122 33')
  expect(doc.bill_to).toMatchObject({ name: 'Acme Trading CC', email: 'ap@acme.test' })
  expect(doc.line_items).toHaveLength(2)
  expect(doc.total).toBe(78)
  expect(Number(doc.subtotal) + Number(doc.vat_amount)).toBeCloseTo(78, 2)
  expect(doc.balance).toBe(78)

  // The order reference travels on the document, so the invoice can be tied back to the sale.
  expect(String(doc.reference_note)).toContain('#640')
  expect((doc as unknown as { order_id: string }).order_id).toBe(ORDER_ID)

  // ── and the existing renderer produces a real PDF from it ──────────────────
  const bytes = await generateDocumentPdfBytes(doc)
  expect(bytes.byteLength).toBeGreaterThan(1000)
  // %PDF- magic number.
  expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
})

test('the renderer is handed the invoice row unchanged — no receipt formatting is involved', async () => {
  const { client } = makeClient()
  const result = await createInvoiceFromOrder(client, {
    orderId: ORDER_ID,
    restaurantId: RESTAURANT_ID,
    createdBy: USER_ID,
    billTo: { name: 'Acme Trading CC' },
  })
  if (!result.ok) throw new Error('expected ok')

  const doc = result.document as Record<string, unknown>
  // A receipt snapshot has `renderer_version` and an `outlet` block. An invoice has neither.
  expect(doc).not.toHaveProperty('renderer_version')
  expect(doc).not.toHaveProperty('outlet')
  expect(doc).not.toHaveProperty('snapshot_json')
})
