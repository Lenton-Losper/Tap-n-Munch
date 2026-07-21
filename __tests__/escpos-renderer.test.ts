import { renderReceiptEscPos } from '../lib/receipts/renderers/escposRenderer'
import type { ReceiptSnapshot } from '../lib/receipts/issueReceipt'

const SNAPSHOT: ReceiptSnapshot = {
  outlet: {
    restaurant_name: 'Test Diner',
    address: '123 Test Street, Windhoek',
  },
  customer_name: null,
  line_items: [
    { name: 'Cheeseburger', quantity: 2, unit_price: 50, line_total: 100 },
    { name: 'Coke', quantity: 1, unit_price: 15, line_total: 15 },
  ],
  totals: {
    subtotal: 115,
    vat: 17.25,
    discount: 0,
    grand_total: 132.25,
  },
  payments: [
    { method: 'card', masked_reference: '****9999', amount: 132.25, paid_at: '2026-07-17T12:00:00Z' },
  ],
}

function bytesToAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii')
}

/** Strips the ESC/GS control sequences the renderer emits, leaving only printable text. */
function stripEscPosCommands(ascii: string): string {
  return ascii.replace(/\x1b\x40|\x1b\x61[\x00-\x02]|\x1b\x45[\x00-\x01]|\x1b\x64.|\x1d\x56./g, '')
}

describe('renderReceiptEscPos', () => {
  it('is a pure function: same input yields identical bytes', () => {
    const a = renderReceiptEscPos(SNAPSHOT)
    const b = renderReceiptEscPos(SNAPSHOT)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('starts with the ESC/POS init sequence and ends with a cut', () => {
    const bytes = renderReceiptEscPos(SNAPSHOT)
    expect(bytes[0]).toBe(0x1b)
    expect(bytes[1]).toBe(0x40)
    // GS V 1 (cut) should appear near the end.
    const tail = Array.from(bytes.slice(-6))
    expect(tail).toEqual(expect.arrayContaining([0x1d, 0x56, 0x01]))
  })

  it('includes outlet identity, line items, totals, and masked payment reference', () => {
    const ascii = bytesToAscii(renderReceiptEscPos(SNAPSHOT))
    expect(ascii).toContain('Test Diner')
    expect(ascii).toContain('123 Test Street, Windhoek')
    expect(ascii).toContain('Cheeseburger')
    expect(ascii).toContain('Coke')
    expect(ascii).toContain('115.00')
    expect(ascii).toContain('17.25')
    expect(ascii).toContain('132.25')
    expect(ascii).toContain('****9999')
  })

  it('never includes a raw unmasked reference beyond what the snapshot already provides', () => {
    const ascii = bytesToAscii(renderReceiptEscPos(SNAPSHOT))
    // The renderer must not derive or print anything beyond the masked_reference field.
    expect(ascii).not.toContain('9999999999999999')
  })

  it('omits the discount line when discount is 0, includes it when present', () => {
    const withDiscount: ReceiptSnapshot = {
      ...SNAPSHOT,
      totals: { ...SNAPSHOT.totals, discount: 10, grand_total: 122.25 },
    }
    const withoutAscii = bytesToAscii(renderReceiptEscPos(SNAPSHOT))
    const withAscii = bytesToAscii(renderReceiptEscPos(withDiscount))
    expect(withoutAscii).not.toContain('Discount')
    expect(withAscii).toContain('Discount')
  })

  it('respects a custom characterWidth', () => {
    const narrow = stripEscPosCommands(bytesToAscii(renderReceiptEscPos(SNAPSHOT, { characterWidth: 24 })))
    const wide = stripEscPosCommands(bytesToAscii(renderReceiptEscPos(SNAPSHOT, { characterWidth: 48 })))
    const narrowLines = narrow.split('\n').filter((l) => l.length > 0)
    const wideLines = wide.split('\n').filter((l) => l.length > 0)
    expect(Math.max(...narrowLines.map((l) => l.length))).toBeLessThanOrEqual(24)
    expect(Math.max(...wideLines.map((l) => l.length))).toBeLessThanOrEqual(48)
  })
})
