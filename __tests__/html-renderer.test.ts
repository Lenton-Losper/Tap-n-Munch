import { renderReceiptHtml } from '../lib/receipts/renderers/htmlRenderer'
import type { ReceiptSnapshot } from '../lib/receipts/issueReceipt'

const SNAPSHOT: ReceiptSnapshot = {
  renderer_version: 'receipt-render-v2',
  outlet: {
    restaurant_name: 'Wanderers Sport Club',
    address: 'Pionierspark, Windhoek',
    vat_number: null,
    registration_number: null,
    currency: 'NAD',
  },
  customer_name: null,
  table_number: null,
  channel: null,
  staff_name: null,
  line_items: [
    { name: '400g T Bone with Chips', quantity: 1, unit_price: 230, line_total: 230, modifiers: [] },
    { name: 'Kola Tonic Tot', quantity: 2, unit_price: 6, line_total: 12, modifiers: [] },
  ],
  totals: { subtotal: 248.69, vat: 37.31, discount: 0, grand_total: 286 },
  payments: [
    { method: 'card', masked_reference: '****1234', amount: 286, paid_at: '2026-07-20T15:14:52Z' },
  ],
}

function printOnlySection(html: string): string {
  const start = html.indexOf('class="print-only"')
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</div>\n</body>', start)
  return html.slice(start, end === -1 ? undefined : end)
}

describe('renderReceiptHtml', () => {
  it('emits one document containing both a screen card and a print-only layout', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    expect(html).toContain('class="screen-only"')
    expect(html).toContain('class="print-only"')
  })

  it('declares an 80mm print page and toggles the two layouts via @media print', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    expect(html).toContain('@page { size: 80mm auto; margin: 0; }')
    expect(html).toMatch(/@media print[\s\S]*\.screen-only\s*{\s*display:\s*none/)
    expect(html).toMatch(/@media print[\s\S]*\.print-only\s*{\s*display:\s*block/)
  })

  it('the print layout has no fixed pixel width (the bug that clipped price columns on 80mm paper)', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toMatch(/width:\s*\d+px/)
    expect(print).not.toContain('420')
  })

  it('renders item description, qty, and price as three separate columns', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).toContain('>400g T Bone with Chips')
    expect(print).toContain('N$230.00')
    // qty > 1 still shows the unit price, now as a sub-line under the item name
    expect(print).toContain('>Kola Tonic Tot')
    expect(print).toContain('@ N$6.00 each')
    expect(print).toContain('N$12.00')
    // the qty column carries the bare quantity number, separate from the name/price cells
    expect(print).toMatch(/align="center"[^>]*>1</)
    expect(print).toMatch(/align="center"[^>]*>2</)
  })

  it('shows ITEM DESCRIPTION / QTY / PRICE column headers above the item list', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const headerIndex = print.indexOf('ITEM DESCRIPTION')
    const qtyHeaderIndex = print.indexOf('>QTY<')
    const priceHeaderIndex = print.indexOf('>PRICE<')
    const firstItemIndex = print.indexOf('400g T Bone with Chips')
    expect(headerIndex).toBeGreaterThan(-1)
    expect(qtyHeaderIndex).toBeGreaterThan(-1)
    expect(priceHeaderIndex).toBeGreaterThan(-1)
    expect(headerIndex).toBeLessThan(firstItemIndex)
    expect(qtyHeaderIndex).toBeLessThan(firstItemIndex)
    expect(priceHeaderIndex).toBeLessThan(firstItemIndex)
  })

  it('prefixes every money value in the print layout with N$, matching the reference receipt', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).toContain('N$230.00')
    expect(print).toContain('N$12.00')
    expect(print).toContain('N$286.00')
    expect(print).toContain('N$248.69')
    expect(print).toContain('N$37.31')
    // every bare (unprefixed) amount that appears should only appear as part of an N$-prefixed one
    expect(print.match(/(?<!N\$)\b\d+\.\d{2}\b/g)).toBeNull()
  })

  it('shows a large, bold Total separated from the items by dashed rules', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const totalIndex = print.indexOf('Total: N$286.00')
    expect(totalIndex).toBeGreaterThan(-1)
    const before = print.slice(0, totalIndex)
    const after = print.slice(totalIndex)
    expect(before).toContain('border-top: 1px dashed')
    expect(after).toContain('border-top: 1px dashed')
    expect(print).toMatch(/font-size:\s*19px[\s\S]*Total: N\$286\.00/)
  })

  it('shows the VAT breakdown after the Total, not folded into it', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const totalIndex = print.indexOf('Total: N$286.00')
    const subtotalIndex = print.indexOf('Subtotal (excl. VAT)')
    const vatIndex = print.lastIndexOf('VAT')
    expect(subtotalIndex).toBeGreaterThan(totalIndex)
    expect(vatIndex).toBeGreaterThan(totalIndex)
    expect(print).toContain('N$248.69')
    expect(print).toContain('N$37.31')
  })

  it('drops the payment method/masked-card row from the print layout entirely', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toContain('CARD')
    expect(print).not.toContain('****1234')
    expect(print.toLowerCase()).not.toContain('payment')
  })

  it('removing the payment row leaves no orphaned divider: exactly 3 dashed rules, ending cleanly at Thank you', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const dashedCount = (print.match(/border-top: 1px dashed #000/g) || []).length
    expect(dashedCount).toBe(3)
    // breakdown table is immediately followed by the Thank-you line, no leftover divider/gap between them
    const breakdownEnd = print.indexOf('</table>', print.indexOf('Subtotal (excl. VAT)'))
    const afterBreakdown = print.slice(breakdownEnd)
    expect(afterBreakdown).not.toContain('border-top: 1px dashed')
    expect(afterBreakdown).toContain('Thank you')
  })

  it('still shows the payment/masked-card row on the screen (email) card -- only print dropped it', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    expect(html).toContain('CARD')
    expect(html).toContain('****1234')
  })

  it('shows the business name bold and larger than the address beneath it', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const nameMatch = print.match(/font-size:\s*(\d+)px; font-weight:\s*700;">Wanderers Sport Club/)
    const addressMatch = print.match(/font-size:\s*(\d+)px;">Pionierspark, Windhoek/)
    expect(nameMatch).not.toBeNull()
    expect(addressMatch).not.toBeNull()
    expect(Number(nameMatch![1])).toBeGreaterThan(Number(addressMatch![1]))
  })

  it('the screen card is unchanged: still a 420px-wide table with Item/Qty/Total headers', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    expect(html).toContain('width="420"')
    expect(html).toContain('>Item<')
    expect(html).toContain('>Qty<')
  })

  it('surrounds the business header with an asterisk rule top and bottom, not just a plain box', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const asteriskCount = (print.match(/\*/g) || []).length
    expect(asteriskCount).toBeGreaterThan(10)
    const firstAsterisk = print.indexOf('*')
    const nameIndex = print.indexOf('Wanderers Sport Club')
    expect(firstAsterisk).toBeGreaterThan(-1)
    expect(firstAsterisk).toBeLessThan(nameIndex)
  })

  it('shows the -YOUR RECEIPT- label beneath the header box', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const nameIndex = print.indexOf('Wanderers Sport Club')
    const labelIndex = print.indexOf('-YOUR RECEIPT-')
    expect(labelIndex).toBeGreaterThan(nameIndex)
  })

  it('shows the receipt document number as plain bold text, never an inverse/highlighted bar', () => {
    const html = renderReceiptHtml(SNAPSHOT, { documentNumber: 'RCT-000123', issuedAt: '2026-07-20T18:55:00Z' })
    const print = printOnlySection(html)
    expect(print).toContain('RCT-000123')
    expect(print).not.toMatch(/background(-color)?:\s*#000/)
    expect(print).not.toContain('color: #fff')
  })

  it('omits the document number line entirely when no documentNumber option is passed', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toContain('Receipt No')
  })

  it('shows the issued_at date/time when passed, formatted for a human reader', () => {
    const html = renderReceiptHtml(SNAPSHOT, { issuedAt: '2026-07-20T18:55:00.000Z' })
    const print = printOnlySection(html)
    expect(print).toMatch(/20 Jul 2026/)
  })

  it('omits the date/time line entirely when no issuedAt option is passed', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toMatch(/\d{2} [A-Z][a-z]{2} \d{4}/)
  })

  it('shows the customer name when present on the snapshot', () => {
    const withName: ReceiptSnapshot = { ...SNAPSHOT, customer_name: 'Jane Doe' }
    const html = renderReceiptHtml(withName)
    const print = printOnlySection(html)
    expect(print).toContain('Name: Jane Doe')
  })

  it('never renders a blank Name: line when customer_name is null (table/POS orders)', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toContain('Name:')
  })

  it('shows an Items: N line with the total quantity across all line items', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    // 1 T-Bone + 2 Kola Tonic Tot = 3
    expect(print).toContain('Items: 3')
  })

  it('left-aligns the Thank you line instead of centering it', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).toMatch(/text-align:\s*left;[^"]*">Thank you/)
  })

  it('still excludes a VAT-rate breakdown line (e.g. "VAT @ 15%") -- unresolved calculation gap', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).not.toMatch(/VAT\s*@\s*\d/)
  })
})
