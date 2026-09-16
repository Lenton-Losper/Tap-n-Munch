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
import { toBusinessDocumentRow } from '@/lib/documents/business-document-row'
import { extractPdfText, extractPdfTextLines } from './helpers/extract-pdf-text'

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

/**
 * ================================================================================================
 * D4 -- THE BILL-TO ADDRESS WAS STORED AND NEVER PRINTED
 * ================================================================================================
 *
 * "Create invoice" on Order History has collected a bill-to address since it shipped, and both
 * writers of the `bill_to` jsonb copy every key of the party object through verbatim. So the
 * address was in the database. It appeared on no invoice: `parseParty` did not name the key on the
 * way back out, and `partyLines` had no branch that drew it.
 *
 * The test below is deliberately not "the PDF is bigger than 1000 bytes". It reads the text back
 * out of the rendered page and asserts the address is on it -- see the note on
 * helpers/extract-pdf-text.ts for why a grep over the raw bytes cannot answer this question.
 */
describe('the invoice PDF prints the party block it was given', () => {
  const ADDRESS = 'PO Box 11, Independence Avenue, Windhoek, Namibia'

  async function renderInvoice(billTo: Record<string, unknown>) {
    const { client } = makeClient()
    const result = await createInvoiceFromOrder(client, {
      orderId: ORDER_ID,
      restaurantId: RESTAURANT_ID,
      createdBy: USER_ID,
      billTo,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
    const doc = result.document as unknown as BusinessDocumentRow
    return { doc, bytes: await generateDocumentPdfBytes(doc) }
  }

  test('the bill-to address is in the extracted text of the rendered PDF', async () => {
    const { doc, bytes } = await renderInvoice({
      name: 'Acme Trading CC',
      email: 'ap@acme.test',
      address: ADDRESS,
    })

    // The address really was stored, so a failure below is about rendering and nothing else.
    expect((doc.bill_to as { address?: string }).address).toBe(ADDRESS)

    const text = await extractPdfText(bytes)

    /**
     * POSITIVE CONTROL, FIRST. If the extractor silently understood nothing, every `toContain`
     * below would fail for the wrong reason and every `not.toContain` would pass for the wrong
     * reason. These two assertions prove the instrument reads this document before it is asked
     * anything about the address.
     */
    expect(text).toContain('Riviera Wine Shop')
    expect(text).toContain('Acme Trading CC')

    /**
     * The address may be wrapped to the Bill To column, so it is asserted line by line rather than
     * as one string -- wrapping is correct behaviour and must not read as a regression.
     */
    for (const word of ['PO', 'Box', '11,', 'Independence', 'Avenue,', 'Windhoek,', 'Namibia']) {
      expect(text).toContain(word)
    }
    // And the whole address survives once the column wrapping is undone.
    expect(text.replace(/\s+/g, ' ')).toContain(ADDRESS)
  })

  test('a newline in the address becomes separate lines, not one run-on line', async () => {
    const { bytes } = await renderInvoice({
      name: 'Acme Trading CC',
      address: 'Unit 4, Maerua Mall\nWindhoek',
    })

    const lines = await extractPdfTextLines(bytes)
    expect(lines).toContain('Unit 4, Maerua Mall')
    expect(lines).toContain('Windhoek')
    expect(lines.some((line) => line.includes('Maerua Mall Windhoek'))).toBe(false)
  })

  test('the existing party lines are unchanged, and in the order they were already in', async () => {
    const { bytes } = await renderInvoice({
      name: 'Acme Trading CC',
      email: 'ap@acme.test',
      organization: 'Acme Group',
      address: 'Erf 512',
      phone: '+264 81 000 0000',
    })

    const lines = await extractPdfTextLines(bytes)
    const at = (value: string) => lines.indexOf(value)

    expect(at('Acme Trading CC')).toBeGreaterThan(-1)
    expect(at('ap@acme.test')).toBeGreaterThan(at('Acme Trading CC'))
    expect(at('Acme Group')).toBeGreaterThan(at('ap@acme.test'))
    expect(at('Erf 512')).toBeGreaterThan(at('Acme Group'))
    expect(at('+264 81 000 0000')).toBeGreaterThan(at('Erf 512'))
  })

  test('an invoice with no bill-to address still renders, and prints no blank line for it', async () => {
    const { bytes } = await renderInvoice({ name: 'Acme Trading CC', email: 'ap@acme.test' })

    const lines = await extractPdfTextLines(bytes)
    expect(lines).toContain('Acme Trading CC')
    expect(lines.some((line) => line.trim() === '')).toBe(false)
  })
})

/**
 * THE DOWNLOAD AND EMAIL PATHS DO NOT GET THE DOCUMENT ROW HANDED TO THEM.
 *
 * Everything above renders `result.document` -- the object createInvoiceFromOrder returns, whose
 * `bill_to` is the jsonb as written. But nobody downloads an invoice that way. Both
 * app/api/admin/documents/[id]/pdf/route.ts and lib/documents/sendDocumentEmail.ts re-read the row
 * from the database and rebuild it with `toBusinessDocumentRow`, and it was THAT parser -- not the
 * renderer -- that dropped `bill_to.address` on the floor.
 *
 * So this is the second half of D4, and the half a test that renders result.document directly
 * cannot see: a renderer that draws an address it is never handed prints nothing.
 */
describe('the stored row survives the round trip the download route makes', () => {
  test('toBusinessDocumentRow keeps bill_to.address, and the PDF prints it', async () => {
    const { client } = makeClient()
    const result = await createInvoiceFromOrder(client, {
      orderId: ORDER_ID,
      restaurantId: RESTAURANT_ID,
      createdBy: USER_ID,
      billTo: { name: 'Acme Trading CC', email: 'ap@acme.test', address: 'Erf 512, Klein Windhoek' },
    })
    if (!result.ok) throw new Error('expected ok')

    // Exactly what the download route does with the row it re-reads from the database.
    const rebuilt = toBusinessDocumentRow(result.document as unknown as Record<string, unknown>)
    expect(rebuilt.bill_to.address).toBe('Erf 512, Klein Windhoek')

    const text = await extractPdfText(await generateDocumentPdfBytes(rebuilt))
    expect(text).toContain('Acme Trading CC') // positive control on the extraction
    expect(text.replace(/\s+/g, ' ')).toContain('Erf 512, Klein Windhoek')
  })
})
