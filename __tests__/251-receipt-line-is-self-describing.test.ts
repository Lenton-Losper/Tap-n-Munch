/**
 * #251 — A RECEIPT LINE MUST SAY WHICH VAT BASIS IT IS ON.
 *
 * THE PROVEN FAILURE, on production, read-only, 2026-08-27.
 *
 * `receipt_documents` holds 1,805 issued receipts. Classifying each by comparing its summed
 * `snapshot_json -> line_items[].line_total` against the order's gross total and its ex-VAT
 * subtotal, and separating out the orders where the two bases are numerically identical:
 *
 *     ZERO-VAT (both bases identical)   984   2026-07-20 .. 2026-08-25
 *     EX-VAT                            820   2026-07-23 .. 2026-08-25
 *     GROSS                               1   2026-08-26 .. 2026-08-26
 *     neither                             0
 *
 * The subject row below is RCT-001838, issued 2026-08-25T13:46:29Z, order
 * 6908e389-ad3e-451b-bbfd-b00f8763214d, restaurant 131c39d1-b816-407d-8c5f-e628fc38967e.
 * Its frozen line reads, verbatim:
 *
 *     {"name":"Muffin","quantity":1,"modifiers":[],"line_total":17.39,"unit_price":20}
 *
 * A N$20.00 unit price beside a N$17.39 line total, on a N$20.00 sale. Re-rendering that same
 * order through the deployed `toLineItem` TODAY produces `line_total: 20` — a different document
 * under the same `renderer_version: receipt-render-v2`. The receipt cannot be re-presented,
 * because the document does not carry the other number and does not say which one it holds.
 *
 * The only rate reachable at render time is `tax_rates` for that restaurant as it stands today
 * (standard 15%, inclusive). That table has no `updated_at` column at all, so a rate change
 * leaves no trace — recomputing a 2026-07 sale from it would silently backdate a current setting
 * onto historical money. That is the failure mode this file exists to make impossible.
 *
 * WHAT THIS FILE DOES NOT DO. It never recomputes a VAT figure and never restates
 * `applyTaxToAmount`'s arithmetic. Every expected number here is either copied verbatim out of a
 * production row or is the *absence* of a number.
 */
import {
  toLineItem,
  receiptLineVatBasis,
  type ReceiptLineItem,
  type ReceiptSnapshot,
} from '@/lib/receipts/issueReceipt'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptEscPos } from '@/lib/receipts/renderers/escposRenderer'
import { renderReceiptSdk6 } from '@/lib/receipts/renderers/sdk6Renderer'
import { renderReceiptPdf } from '@/lib/receipts/renderers/pdfRenderer'
import { inflateSync } from 'zlib'

/**
 * `orders.items[0]` for order 6908e389-ad3e-451b-bbfd-b00f8763214d, copied verbatim from
 * production. This is the row RCT-001838 was built from, and it still carries every figure the
 * snapshot needed. 820 of 820 mis-based receipts have all five keys on their order row.
 */
const PRODUCTION_ORDER_LINE = {
  tax: 2.61,
  name: 'Muffin',
  total: 20,
  quantity: 1,
  route_to: 'both',
  subtotal: 17.39,
  basePrice: 20,
  taxRateId: '33eb2e73-40c5-42e9-9de5-113362933ed2',
  unitPrice: 20,
  menuItemId: 'bfac38af-bdcb-4141-be2c-8e94011c3d7c',
  priceSource: 'catalog',
  taxInclusive: true,
  taxRatePercentage: 15,
} as const

/** `snapshot_json.line_items[0]` of RCT-001838, copied verbatim from production. */
const FROZEN_RCT_001838_LINE: ReceiptLineItem = {
  name: 'Muffin',
  quantity: 1,
  modifiers: [],
  line_total: 17.39,
  unit_price: 20,
}

describe('#251: a newly issued line carries its own VAT split', () => {
  it('copies the ex-VAT and tax halves off the real production order line', () => {
    const line = toLineItem(PRODUCTION_ORDER_LINE)

    // Unchanged by #251, and still #250's rule: the printed figure is the gross one.
    expect(line.line_total).toBe(20)
    expect(line.unit_price).toBe(20)

    // New: the other number is now in the document.
    expect(line.line_subtotal).toBe(17.39)
    expect(line.line_tax).toBe(2.61)
  })

  it('freezes the rate that produced the split, so no reader needs the tax_rates table', () => {
    const line = toLineItem(PRODUCTION_ORDER_LINE)

    expect(line.tax_rate_percentage).toBe(15)
    expect(line.tax_inclusive).toBe(true)
  })

  it('answers the basis question with the stored numbers', () => {
    const basis = receiptLineVatBasis(toLineItem(PRODUCTION_ORDER_LINE))

    expect(basis).toEqual({
      gross: 20,
      ex_vat: 17.39,
      tax: 2.61,
      tax_rate_percentage: 15,
      tax_inclusive: true,
    })
  })
})

describe('#251: an OLD row answers "unknown", never a recomputed number', () => {
  /**
   * THE LOAD-BEARING ASSERTION OF THIS WHOLE ISSUE. RCT-001838 is one of 820 real receipts.
   * After the fix it is still exactly as issued, and asking it for its basis returns null —
   * not 20.00, not 17.39-times-1.15, not anything derived from today's 15% rate.
   */
  it('returns null for RCT-001838 as it is actually stored on production', () => {
    expect(receiptLineVatBasis(FROZEN_RCT_001838_LINE)).toBeNull()
  })

  it('returns null rather than treating line_total as gross with zero tax', () => {
    const basis = receiptLineVatBasis(FROZEN_RCT_001838_LINE)

    // The tempting wrong answer: {gross: 17.39, ex_vat: 17.39, tax: 0}. 17.39 is the ex-VAT
    // figure of a 20.00 sale; reporting it as a gross total understates the sale by 2.61.
    expect(basis).not.toEqual(
      expect.objectContaining({ gross: 17.39, ex_vat: 17.39, tax: 0 }),
    )
    expect(basis).toBeNull()
  })

  it('returns null for a stored split that does not add up', () => {
    // Not hypothetical protection: snapshot_json is opaque jsonb that has sat in the database
    // for months. A split that fails to reconcile must not be believed just because it is present.
    expect(
      receiptLineVatBasis({
        ...FROZEN_RCT_001838_LINE,
        line_total: 20,
        line_subtotal: 17.39,
        line_tax: 9.99,
      }),
    ).toBeNull()
  })
})

describe('#251: the split is copied, never guessed', () => {
  it('attaches nothing to a cart-shaped line, which has no tax to copy', () => {
    // components/menu/item-detail-modal.tsx stores `subtotal: calculatePrice()` — already gross,
    // and there is no `tax` key. Copying `subtotal` into `line_subtotal` would file a gross
    // number under an ex-VAT name, which is the exact confusion #251 is about.
    const line = toLineItem({ name: 'Burger', quantity: 2, basePrice: 50, subtotal: 115 })

    expect(line.line_total).toBe(115)
    expect(line).not.toHaveProperty('line_subtotal')
    expect(line).not.toHaveProperty('line_tax')
    expect(receiptLineVatBasis(line)).toBeNull()
  })

  it('attaches nothing to a line that has a subtotal and a total but no tax key', () => {
    // The subtler half of the same trap, and the one a cart-shaped line does not cover: both
    // money keys are present, so only the ABSENCE of `tax` distinguishes "no VAT was charged"
    // from "the VAT is not recorded here". Reading the gap as zero would print a zero-VAT
    // receipt for a sale whose VAT nobody looked up.
    const line = toLineItem({ name: 'Taxless', quantity: 1, subtotal: 20, total: 20 })

    expect(line.line_total).toBe(20)
    expect(line).not.toHaveProperty('line_subtotal')
    expect(line).not.toHaveProperty('line_tax')
  })

  it('attaches nothing to a line with a tax but no subtotal', () => {
    // Reading the missing half as zero would record a sale as 100% VAT. The reconciliation gate
    // does not catch this on its own — 0 + 20 does equal the printed 20 — so the presence check
    // is what stands between an opaque order row and a receipt that claims the whole charge
    // was tax.
    const line = toLineItem({ name: 'TaxOnly', quantity: 1, tax: 20, total: 20 })

    expect(line.line_total).toBe(20)
    expect(line).not.toHaveProperty('line_subtotal')
    expect(line).not.toHaveProperty('line_tax')
  })

  it('attaches nothing when subtotal and tax do not reconcile', () => {
    const line = toLineItem({ name: 'Bad', quantity: 1, subtotal: 17.39, tax: 9.99, total: 20 })

    expect(line.line_total).toBe(20)
    expect(line).not.toHaveProperty('line_subtotal')
  })

  it('reconciles against the figure being PRINTED, not against the line\'s `total` key', () => {
    // `line_total` resolves from four keys in order, and `total` is only the first. Here the
    // printed figure comes from `total` and the split describes something else entirely; a split
    // that adds up to a number the customer cannot see on the paper is the very disagreement
    // #251 is about, so it must not be attached.
    const line = toLineItem({ name: 'Elsewhere', quantity: 1, subtotal: 8.7, tax: 1.3, total: 25 })

    expect(line.line_total).toBe(25)
    expect(line).not.toHaveProperty('line_subtotal')
  })

  it('still attaches when the printed figure came from a key other than `total`', () => {
    // The positive half of the same rule, and the one that pins WHICH number the gate reconciles
    // against. `total` is absent here, so `line_total` resolves from `line_total`; the split adds
    // up to the printed 10.00 and therefore describes the document. A gate written against
    // `item.total` would silently drop the split on every line of this shape.
    const line = toLineItem({ name: 'Aliased', quantity: 1, line_total: 10, subtotal: 8.7, tax: 1.3 })

    expect(line.line_total).toBe(10)
    expect(line.line_subtotal).toBe(8.7)
    expect(line.line_tax).toBe(1.3)
  })

  it('omits the rate when the line carried a split but no rate', () => {
    const line = toLineItem({ name: 'Rateless', quantity: 1, subtotal: 8.7, tax: 1.3, total: 10 })

    expect(line.line_subtotal).toBe(8.7)
    expect(line).not.toHaveProperty('tax_rate_percentage')
    expect(receiptLineVatBasis(line)).toEqual({
      gross: 10,
      ex_vat: 8.7,
      tax: 1.3,
      tax_rate_percentage: null,
      tax_inclusive: null,
    })
  })
})

/**
 * ALL FOUR RENDERERS MUST BE BLIND TO THE NEW FIELDS.
 *
 * The change is only safe because it is additive: an old snapshot and a new snapshot that agree
 * on `line_total` must produce byte-identical output on every surface, so shipping this cannot
 * alter a single reprint. Rendering both and comparing is the only way to establish that without
 * restating what each renderer does.
 */
function snapshotWith(lineItems: ReceiptLineItem[]): ReceiptSnapshot {
  return {
    renderer_version: 'receipt-render-v2',
    outlet: {
      restaurant_name: 'Test Outlet',
      address: null,
      vat_number: null,
      registration_number: null,
      currency: 'NAD',
    },
    customer_name: null,
    table_number: null,
    channel: null,
    staff_name: null,
    order_instructions: null,
    line_items: lineItems,
    totals: { subtotal: 17.39, vat: 2.61, discount: 0, grand_total: 20 },
    payments: [{ method: 'cash', masked_reference: '', amount: 20, paid_at: '2026-08-25T13:46:29.821Z' }],
  }
}

const WITHOUT_SPLIT = snapshotWith([
  { name: 'Muffin', quantity: 1, modifiers: [], line_total: 20, unit_price: 20 },
])
const WITH_SPLIT = snapshotWith([
  {
    name: 'Muffin',
    quantity: 1,
    modifiers: [],
    line_total: 20,
    unit_price: 20,
    line_subtotal: 17.39,
    line_tax: 2.61,
    tax_rate_percentage: 15,
    tax_inclusive: true,
  },
])
const OPTS = { documentNumber: 'RCT-001838', issuedAt: '2026-08-25T13:46:29.821Z' }

/**
 * Every string pdf-lib actually draws, in page order.
 *
 * Three things make the obvious comparisons useless, and each was hit in turn while writing this:
 *  - the raw bytes differ between two saves of the SAME document, because pdf-lib stamps a fresh
 *    CreationDate and /ID;
 *  - the content streams are FlateDecode, so nothing readable survives without inflating;
 *  - pdf-lib writes text as HEX strings (`<54657374> Tj`), not as `(...)` literals, so a
 *    paren-matching extractor finds only the two CreationDate values in the trailer and reports
 *    every pair of documents as identical. That is precisely what the control below caught.
 *
 * Font resources also carry a per-document random tag (`/Helvetica-7098480789`), so the inflated
 * stream cannot be compared wholesale either. The `Tj` operands can.
 */
function drawnText(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes)
  const out: string[] = []
  let index = raw.indexOf('stream')

  while (index !== -1) {
    let start = index + 'stream'.length
    if (raw[start] === 0x0d) start += 1
    if (raw[start] === 0x0a) start += 1
    const end = raw.indexOf('endstream', start)
    if (end === -1) break

    let content: string
    try {
      content = inflateSync(raw.subarray(start, end)).toString('latin1')
    } catch {
      content = raw.subarray(start, end).toString('latin1')
    }
    for (const match of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(match[1], 'hex').toString('latin1'))
    }

    index = raw.indexOf('stream', end + 'endstream'.length)
  }

  return out
}

describe('#251: widening the line changes no rendered output', () => {
  it('ESC/POS is byte-identical', () => {
    expect(Array.from(renderReceiptEscPos(WITH_SPLIT, OPTS))).toEqual(
      Array.from(renderReceiptEscPos(WITHOUT_SPLIT, OPTS)),
    )
  })

  it('HTML is identical, in both the screen and the print layout', () => {
    expect(renderReceiptHtml(WITH_SPLIT, OPTS)).toBe(renderReceiptHtml(WITHOUT_SPLIT, OPTS))
  })

  it('SDK6 structured lines are identical', () => {
    expect(renderReceiptSdk6(WITH_SPLIT, OPTS)).toEqual(renderReceiptSdk6(WITHOUT_SPLIT, OPTS))
  })

  it('PDF drawn content is identical', async () => {
    expect(drawnText(await renderReceiptPdf(WITH_SPLIT, OPTS))).toEqual(
      drawnText(await renderReceiptPdf(WITHOUT_SPLIT, OPTS)),
    )
  })

  it('CONTROL: drawnText() can tell two PDFs apart', async () => {
    // Without this, the assertion above would pass just as happily on an extractor that returns
    // the same empty array for every document — which is what a raw-byte comparison degenerated
    // into, since pdf-lib deflates its content streams and stamps a fresh CreationDate per save.
    const different = snapshotWith([
      { name: 'Croissant', quantity: 3, modifiers: [], line_total: 20, unit_price: 20 },
    ])

    expect(drawnText(await renderReceiptPdf(different, OPTS))).not.toEqual(
      drawnText(await renderReceiptPdf(WITHOUT_SPLIT, OPTS)),
    )
    expect(drawnText(await renderReceiptPdf(WITHOUT_SPLIT, OPTS)).join('')).toContain('Muffin')
  })
})
