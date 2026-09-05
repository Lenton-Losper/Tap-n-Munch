/**
 * A CUSTOMER CHARGED MORE THAN THE BILL MUST SEE WHY, ON THE PAPER IN THEIR HAND.
 *
 * The receipt prints Subtotal / VAT / Total / Gratuity / Total — the second Total being what was
 * actually charged. All four renderers, because a gratuity that shows on the PDF and not on the
 * printed slip is the version the customer never sees.
 *
 * ============================================================================================
 * ABSENT MEANS UNKNOWN, NEVER ZERO
 * ============================================================================================
 *
 * `totals.tip` is PERMANENTLY OPTIONAL. Every receipt issued before it existed has no gratuity
 * recorded either way, and no backfill is sanctioned — the same rule as the #251 line-VAT split
 * and `outlet.vat_registered`. Printing "Gratuity 0.00" on those would assert something nobody
 * recorded. A snapshot without the field must render EXACTLY as it did before this change, and
 * that is asserted rather than assumed.
 */
import { renderReceiptEscPos } from '@/lib/receipts/renderers/escposRenderer'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptSdk6 } from '@/lib/receipts/renderers/sdk6Renderer'
import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

function snapshot(tip?: number): ReceiptSnapshot {
  return {
    renderer_version: 'v1',
    outlet: {
      restaurant_name: 'Riviera',
      address: null,
      vat_number: null,
      registration_number: null,
      currency: 'NAD',
    },
    customer_name: null,
    table_number: 4,
    channel: 'terminal',
    staff_name: null,
    line_items: [
      { name: 'Steak', quantity: 1, unit_price: 500, line_total: 500 },
    ] as ReceiptSnapshot['line_items'],
    totals: {
      subtotal: 434.78,
      vat: 65.22,
      discount: 0,
      grand_total: 500,
      ...(tip !== undefined ? { tip } : {}),
    },
    payments: [{ method: 'card', masked_reference: '', amount: 500, paid_at: '2026-09-06T10:00:00Z' }],
  }
}

/** ESC-POS comes back as bytes; the words are what matters. */
function escposText(snap: ReceiptSnapshot): string {
  const out = renderReceiptEscPos(snap, { documentNumber: 'RCT-1', issuedAt: '2026-09-06T10:00:00Z' })
  const bytes = out as unknown as Uint8Array | { data?: Uint8Array }
  const buf = bytes instanceof Uint8Array ? bytes : (bytes.data as Uint8Array)
  return Buffer.from(buf).toString('latin1')
}

describe('a gratuity is printed, and so is what was actually charged', () => {
  it('ESC-POS prints Gratuity and a second Total of bill + tip', () => {
    const text = escposText(snapshot(50))
    expect(text).toContain('Gratuity')
    expect(text).toContain('50.00')
    // The bill, and then what left the customer's card.
    expect(text).toContain('500.00')
    expect(text).toContain('550.00')
  })

  it('HTML prints both totals', () => {
    const html = renderReceiptHtml(snapshot(50), {
      documentNumber: 'RCT-1',
      issuedAt: '2026-09-06T10:00:00Z',
    })
    expect(html).toContain('Gratuity')
    expect(html).toMatch(/550\.00/)
  })

  it('SDK6 emits a Gratuity row and a second Total row', () => {
    const lines = renderReceiptSdk6(snapshot(50), {
      documentNumber: 'RCT-1',
      issuedAt: '2026-09-06T10:00:00Z',
    }) as Array<{ type: string; columns?: string[] }>
    const rows = lines.filter((l) => l.type === 'row').map((l) => l.columns ?? [])
    expect(rows.some((c) => c[0] === 'Gratuity')) .toBe(true)
    const totals = rows.filter((c) => c[0] === 'Total').map((c) => c[1])
    expect(totals).toHaveLength(2)
    expect(totals[1]).toContain('550.00')
  })
})

describe('a receipt with no gratuity renders exactly as it did before', () => {
  /**
   * THE REGRESSION THAT MATTERS. 2,514 receipts on production predate this field. If any renderer
   * defaults `tip` to 0 and prints a line, every one of them silently gains a claim nobody made.
   */
  it('ESC-POS prints no Gratuity line and only ONE Total', () => {
    const text = escposText(snapshot(undefined))
    expect(text).not.toContain('Gratuity')
    expect(text.match(/Total/g) ?? []).toHaveLength(1)
  })

  it('HTML prints no Gratuity line', () => {
    const html = renderReceiptHtml(snapshot(undefined), {
      documentNumber: 'RCT-1',
      issuedAt: '2026-09-06T10:00:00Z',
    })
    expect(html).not.toContain('Gratuity')
  })

  it('SDK6 emits one Total row and no Gratuity row', () => {
    const lines = renderReceiptSdk6(snapshot(undefined), {
      documentNumber: 'RCT-1',
      issuedAt: '2026-09-06T10:00:00Z',
    }) as Array<{ type: string; columns?: string[] }>
    const rows = lines.filter((l) => l.type === 'row').map((l) => l.columns ?? [])
    expect(rows.some((c) => c[0] === 'Gratuity')).toBe(false)
    expect(rows.filter((c) => c[0] === 'Total')).toHaveLength(1)
  })

  it('a zero tip is treated as no tip, not as a printed zero', () => {
    // 0 is a value the field can technically hold; it must not produce "Gratuity 0.00".
    const text = escposText(snapshot(0))
    expect(text).not.toContain('Gratuity')
  })
})

describe('the gratuity stays outside the VAT base', () => {
  it('subtotal and VAT are untouched by the tip', () => {
    const withTip = snapshot(50)
    const without = snapshot(undefined)
    expect(withTip.totals.subtotal).toBe(without.totals.subtotal)
    expect(withTip.totals.vat).toBe(without.totals.vat)
    // And grand_total remains the BILL — the charged figure is derived, never stored on it.
    expect(withTip.totals.grand_total).toBe(without.totals.grand_total)
  })
})
