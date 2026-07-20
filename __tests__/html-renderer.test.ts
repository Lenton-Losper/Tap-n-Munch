import { renderReceiptHtml } from '../lib/receipts/renderers/htmlRenderer'
import type { ReceiptSnapshot } from '../lib/receipts/issueReceipt'

const SNAPSHOT: ReceiptSnapshot = {
  outlet: { restaurant_name: 'Wanderers Sport Club', address: 'Pionierspark, Windhoek' },
  line_items: [
    { name: '400g T Bone with Chips', quantity: 1, unit_price: 230, line_total: 230 },
    { name: 'Kola Tonic Tot', quantity: 2, unit_price: 6, line_total: 12 },
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

  it('renders quantity + item name and price on the same row, right-aligned', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    expect(print).toContain('1 400g T Bone with Chips')
    expect(print).toContain('230.00')
    // qty > 1 shows the unit price inline
    expect(print).toContain('2 Kola Tonic Tot @ 6.00')
    expect(print).toContain('12.00')
  })

  it('shows a large, bold Total separated from the items by dashed rules', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const totalIndex = print.indexOf('Total: 286.00')
    expect(totalIndex).toBeGreaterThan(-1)
    const before = print.slice(0, totalIndex)
    const after = print.slice(totalIndex)
    expect(before).toContain('border-top: 1px dashed')
    expect(after).toContain('border-top: 1px dashed')
    expect(print).toMatch(/font-size:\s*19px[\s\S]*Total: 286\.00/)
  })

  it('shows the VAT breakdown after the Total, not folded into it', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const print = printOnlySection(html)
    const totalIndex = print.indexOf('Total: 286.00')
    const subtotalIndex = print.indexOf('Subtotal (excl. VAT)')
    const vatIndex = print.lastIndexOf('VAT')
    expect(subtotalIndex).toBeGreaterThan(totalIndex)
    expect(vatIndex).toBeGreaterThan(totalIndex)
    expect(print).toContain('248.69')
    expect(print).toContain('37.31')
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
})
