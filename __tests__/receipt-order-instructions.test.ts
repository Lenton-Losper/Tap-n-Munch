/**
 * Issue #135. `orders.order_instructions` -- what the customer typed into the order-level
 * "note for the whole order" box -- survived cart -> order row -> staff view and then stopped:
 * issueReceiptForOrder never selected the column and ReceiptSnapshot had nowhere to put it, so
 * no receipt in any format has ever shown it.
 *
 * The snapshot is frozen at issue time, so the value has to be captured there, not looked up
 * at render time. Instructions are capped at 280 characters in the UI (#129) and the column is
 * unvalidated `text`, so the renderers are exercised at that length: the thermal path must
 * wrap it, not truncate it, and the A4 PDF must still fit on the page.
 */
import { issueReceiptForOrder, type ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptEscPos } from '@/lib/receipts/renderers/escposRenderer'
import { renderReceiptSdk6 } from '@/lib/receipts/renderers/sdk6Renderer'
import { renderReceiptPdf } from '@/lib/receipts/renderers/pdfRenderer'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'

// --- fake Supabase, enough for issueReceiptForOrder's fixed sequence of reads ---

let orderRow: Record<string, unknown>
let orderSelectColumns = ''
let insertedSnapshot: ReceiptSnapshot | null = null

function makeSupabaseMock() {
  return {
    from(table: string) {
      if (table === 'receipt_documents') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            insertedSnapshot = payload.snapshot_json as ReceiptSnapshot
            return {
              select: () => ({
                single: async () => ({ data: { id: 'doc-1', ...payload }, error: null }),
              }),
            }
          },
        }
      }
      if (table === 'orders') {
        return {
          select: (columns: string) => {
            orderSelectColumns = columns
            return { eq: () => ({ single: async () => ({ data: orderRow, error: null }) }) }
          },
        }
      }
      if (table === 'restaurants') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { name: 'Riviera', address: 'Windhoek', currency: 'NAD' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'restaurant_billing_profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }
      }
      if (table === 'payment_events') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ contains: async () => ({ data: [], error: null }) }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async () => ({ data: 'RCT-000001', error: null }),
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

// Exactly the UI cap (#129), ending in a full stop so it survives a trim() unchanged.
const LONG_NOTE =
  `Allergy: ${'peanuts, '.repeat(31)}`.slice(0, MAX_INSTRUCTIONS_LENGTH - 1) + '.'

function baseOrder(instructions: unknown): Record<string, unknown> {
  return {
    id: 'order-1',
    restaurant_id: 'rest-1',
    payment_status: 'paid',
    payment_method: 'cash',
    payment_reference: null,
    paycloud_merchant_order_no: null,
    paid_at: '2026-08-01T10:00:00Z',
    subtotal: 100,
    tax: 15,
    total: 115,
    items: [{ name: 'Burger', quantity: 1, basePrice: 115, subtotal: 115 }],
    customer_name: null,
    table_number: 4,
    channel: 'qr',
    order_instructions: instructions,
  }
}

describe('issueReceiptForOrder captures order_instructions (#135)', () => {
  beforeEach(() => {
    insertedSnapshot = null
    orderSelectColumns = ''
  })

  it('selects the column and freezes the value into the snapshot', async () => {
    orderRow = baseOrder('No cutlery please, we brought our own.')
    await issueReceiptForOrder('order-1')

    expect(orderSelectColumns).toContain('order_instructions')
    expect(insertedSnapshot?.order_instructions).toBe('No cutlery please, we brought our own.')
  })

  it('records null rather than an empty string when the customer wrote nothing', async () => {
    orderRow = baseOrder('   ')
    await issueReceiptForOrder('order-1')
    expect(insertedSnapshot?.order_instructions).toBeNull()

    orderRow = baseOrder(null)
    await issueReceiptForOrder('order-1')
    expect(insertedSnapshot?.order_instructions).toBeNull()
  })

  it('keeps a full-length note intact -- the receipt is not the place to silently trim it', async () => {
    orderRow = baseOrder(LONG_NOTE)
    await issueReceiptForOrder('order-1')
    expect(insertedSnapshot?.order_instructions).toBe(LONG_NOTE)
    expect(LONG_NOTE.length).toBe(MAX_INSTRUCTIONS_LENGTH)
  })
})

// --- renderers ---

const SNAPSHOT: ReceiptSnapshot = {
  renderer_version: 'receipt-render-v2',
  outlet: {
    restaurant_name: 'Riviera',
    address: 'Windhoek',
    vat_number: null,
    registration_number: null,
    currency: 'NAD',
  },
  customer_name: null,
  table_number: 4,
  channel: 'qr',
  staff_name: null,
  order_instructions: 'No cutlery please & keep the <chips> separate',
  line_items: [{ name: 'Burger', quantity: 1, unit_price: 115, line_total: 115, modifiers: [] }],
  totals: { subtotal: 100, vat: 15, discount: 0, grand_total: 115 },
  payments: [{ method: 'cash', masked_reference: '', amount: 115, paid_at: '2026-08-01T10:00:00Z' }],
}

const WITHOUT_NOTE: ReceiptSnapshot = { ...SNAPSHOT, order_instructions: null }
/** A snapshot frozen before this field existed -- every receipt issued so far. */
const LEGACY: ReceiptSnapshot = { ...SNAPSHOT }
delete (LEGACY as { order_instructions?: unknown }).order_instructions

describe('renderers show the order note (#135)', () => {
  it('HTML shows it in both the emailed card and the thermal print layout, escaped', () => {
    const html = renderReceiptHtml(SNAPSHOT)
    const screen = html.slice(html.indexOf('class="screen-only"'), html.indexOf('class="print-only"'))
    const print = html.slice(html.indexOf('class="print-only"'))

    expect(screen).toContain('No cutlery please &amp; keep the &lt;chips&gt; separate')
    expect(print).toContain('No cutlery please &amp; keep the &lt;chips&gt; separate')
    expect(html).not.toContain('<chips>')
  })

  it('HTML says nothing at all when there is no note, old snapshot or new', () => {
    expect(renderReceiptHtml(WITHOUT_NOTE)).not.toMatch(/Order note/i)
    expect(renderReceiptHtml(LEGACY)).not.toMatch(/Order note/i)
  })

  it('ESC/POS wraps a 280-character note instead of cutting it at the column width', () => {
    const bytes = renderReceiptEscPos({ ...SNAPSHOT, order_instructions: LONG_NOTE }, {
      characterWidth: 32,
    })
    // Drop the ESC/GS command sequences before measuring: their parameter byte is often a
    // printable character ("ESC a 1"), which would otherwise count towards the line width.
    const text = Buffer.from(bytes)
      .toString('ascii')
      .replace(/\x1b@/g, '')
      .replace(/[\x1b\x1d][\s\S][\s\S]/g, '')

    // Every word survives...
    for (const word of LONG_NOTE.split(/\s+/)) {
      expect(text).toContain(word)
    }
    // ...and no printed line is wider than the paper.
    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(32)
    }
    expect(text).not.toContain('…')
  })

  it('ESC/POS and SDK6 leave the note out entirely when there is none', () => {
    const text = Buffer.from(renderReceiptEscPos(WITHOUT_NOTE)).toString('ascii')
    expect(text).not.toMatch(/Order note/i)
    expect(renderReceiptSdk6(LEGACY).some((l) => 'text' in l && /Order note/i.test(l.text))).toBe(false)
  })

  it('SDK6 emits the note for the P5 printer', () => {
    const lines = renderReceiptSdk6(SNAPSHOT)
    const rendered = lines.map((l) => ('text' in l ? l.text : '')).join('\n')
    expect(rendered).toContain('No cutlery please & keep the <chips> separate')
  })

  it('PDF fits a 280-character note on the page without overflowing the footer', async () => {
    const overflow = jest.spyOn(console, 'error').mockImplementation(() => {})
    const bytes = await renderReceiptPdf({ ...SNAPSHOT, order_instructions: LONG_NOTE }, {
      documentNumber: 'RCT-000001',
      issuedAt: '2026-08-01T10:00:00Z',
    })
    expect(Buffer.from(bytes).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(overflow).not.toHaveBeenCalled()
    overflow.mockRestore()
  })
})
