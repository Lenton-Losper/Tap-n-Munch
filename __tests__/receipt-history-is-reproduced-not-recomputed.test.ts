/**
 * A historical receipt must REPRODUCE the sale that happened, never recompute it from data that
 * has moved on since.
 *
 * ============================================================================================
 * WHY A STRUCTURAL TEST AND NOT MORE UNIT TESTS
 * ============================================================================================
 *
 * The unit coverage here is already good: `issue-receipt`, `251-receipt-line-is-self-describing`,
 * `receipt-line-total-is-gross` and `receipt-vat-arithmetic` all pin what a snapshot CONTAINS.
 * Not one of them pins the property that makes those contents worth anything — that the render
 * path reads the snapshot and nothing else.
 *
 * That property currently holds. Audited 2026-09-01: all six renderers are pure functions over a
 * `ReceiptSnapshot`, every serving route renders from `snapshot_json`, and 2,514 production
 * receipts reconcile (payments equal grand total on 2,512; the other two are pre-fallback
 * documents from July 2026). Nothing enforces it, so nothing stops the next well-meaning change
 * from passing an order id into a renderer and "looking up the current VAT rate".
 *
 * The codebase already knows why that would be catastrophic, in issueReceipt's own words: the
 * `tax_rates` table "is mutable, has no `updated_at`, and would silently backdate today's rate
 * onto a historical sale". A receipt reprinted a year later would then disagree with the one the
 * customer holds — and would do so silently, because nothing would error.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ============================================================================================
 *
 * That routes never read `orders`. They must: to find the document and to check that this
 * caller may see it. The rule is about what reaches the RENDERER, not about authorisation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptEscPos } from '@/lib/receipts/renderers/escposRenderer'
import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

const ROOT = join(__dirname, '..')
const RENDERER_DIR = join(ROOT, 'lib', 'receipts', 'renderers')

const rendererFiles = readdirSync(RENDERER_DIR).filter((f) => f.endsWith('.ts'))
const readRenderer = (f: string) => readFileSync(join(RENDERER_DIR, f), 'utf8')

/** Tables whose contents change after a sale. Reading any of them at render time backdates. */
const MUTABLE_SOURCES = [
  'tax_rates',
  'menu_items',
  'menu_categories',
  'restaurants',
  'restaurant_billing_profiles',
  'payment_events',
  'orders',
]

describe('the renderers are pure functions over a frozen snapshot', () => {
  it('there are renderers to check', () => {
    // Guards the whole file: a glob that matched nothing would make every test below vacuous.
    expect(rendererFiles.length).toBeGreaterThanOrEqual(4)
  })

  it.each(rendererFiles)('%s imports no database client', (file) => {
    const src = readRenderer(file)
    expect(src).not.toMatch(/@\/lib\/supabase/)
    expect(src).not.toMatch(/createServerSupabaseClient|createClient\s*\(/)
  })

  it.each(rendererFiles)('%s performs no table read at all', (file) => {
    const src = readRenderer(file)
    expect(src).not.toMatch(/\.from\(\s*['"]/)
    expect(src).not.toMatch(/\.rpc\(\s*['"]/)
  })

  it.each(rendererFiles)('%s never names a mutable source', (file) => {
    const src = readRenderer(file)
    for (const table of MUTABLE_SOURCES) {
      // Quoted table name — a comment mentioning `orders` in prose is fine and common here.
      expect(src).not.toMatch(new RegExp(`['"]${table}['"]`))
    }
  })

  it('every renderer entry point takes a snapshot, never an id to go and look up', () => {
    const entries = rendererFiles
      .map((f) => ({ f, src: readRenderer(f) }))
      .filter(({ src }) => /export (async )?function render/.test(src))
    expect(entries.length).toBeGreaterThanOrEqual(3)
    for (const { f, src } of entries) {
      const sig = src.match(/export (?:async )?function render\w+\(([\s\S]{0,160}?)\)/)
      expect(sig).not.toBeNull()
      expect(`${f}: ${sig![1]}`).toMatch(/snapshot:\s*ReceiptSnapshot/)
    }
  })
})

describe('every serving route renders from the stored snapshot', () => {
  /** Routes that turn a receipt into bytes a human sees. */
  const SERVING_ROUTES = [
    'app/api/orders/[orderId]/receipt/route.ts',
    'app/api/guest/orders/[orderId]/receipt/route.ts',
    'app/api/terminal/receipts/[orderId]/route.ts',
  ]

  it.each(SERVING_ROUTES)('%s passes snapshot_json to the renderer', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    expect(src).toMatch(/render\w*\(\s*(?:receipt\.)?snapshot(_json)?/)
    expect(src).toContain('snapshot_json')
  })

  it.each(SERVING_ROUTES)('%s does not consult tax_rates when serving', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    expect(src).not.toMatch(/['"]tax_rates['"]/)
  })
})

describe('the same snapshot renders the same, whatever the venue looks like now', () => {
  const SNAPSHOT: ReceiptSnapshot = {
    renderer_version: 'receipt-render-v2',
    outlet: {
      // Deliberately a name no live row could hold, so a renderer that reached for the current
      // restaurant record would produce something else and be caught.
      restaurant_name: 'THE OLD NAME AT TIME OF SALE',
      address: '12 Independence Ave',
      vat_number: 'VAT-AT-TIME-OF-SALE',
      registration_number: 'REG-AT-TIME-OF-SALE',
      currency: 'NAD',
    },
    customer_name: null,
    table_number: 7,
    channel: 'table',
    staff_name: null,
    order_instructions: null,
    line_items: [
      {
        name: 'Ribeye',
        quantity: 1,
        unit_price: 25,
        line_total: 25,
        modifiers: [],
        line_subtotal: 21.74,
        line_tax: 3.26,
        tax_rate_percentage: 15,
        tax_inclusive: true,
      },
    ],
    totals: { subtotal: 21.74, vat: 3.26, discount: 0, grand_total: 25 },
    payments: [
      { method: 'card', masked_reference: '****4321', amount: 25, paid_at: '2026-07-01T10:00:00Z' },
    ],
  }

  const OPTS = { documentNumber: 'RCT-000001', issuedAt: '2026-07-01T10:00:05Z' }

  it('prints the outlet identity frozen on the document', () => {
    const html = renderReceiptHtml(SNAPSHOT, OPTS)
    expect(html).toContain('THE OLD NAME AT TIME OF SALE')
    expect(html).toContain('VAT-AT-TIME-OF-SALE')
  })

  it('is byte-identical across repeated renders — no clock, no lookup, no drift', () => {
    const a = renderReceiptHtml(SNAPSHOT, OPTS)
    const b = renderReceiptHtml(SNAPSHOT, OPTS)
    expect(a).toBe(b)

    const escA = renderReceiptEscPos(SNAPSHOT, OPTS)
    const escB = renderReceiptEscPos(SNAPSHOT, OPTS)
    expect(Buffer.from(escA as never).equals(Buffer.from(escB as never))).toBe(true)
  })

  it('uses the frozen rate, and cannot be made to apply a different one', () => {
    // There is no seam to inject a rate through — which is the point. The rendered VAT is the
    // stored VAT, whatever tax_rates says today.
    const html = renderReceiptHtml(SNAPSHOT, OPTS)
    expect(html).toContain('3.26')
    expect(html).not.toContain('3.75') // 15% OF the gross, i.e. what recomputing would produce
  })

  /**
   * A snapshot issued before `currency` existed on the outlet block. 193 production receipts are
   * in this shape. Every render site defaults to NAD; this pins that so a renderer cannot start
   * printing "undefined12.00" on a historical reprint.
   */
  it('renders a pre-currency snapshot without leaking undefined', () => {
    const legacy = JSON.parse(JSON.stringify(SNAPSHOT)) as ReceiptSnapshot
    delete (legacy.outlet as { currency?: string }).currency
    const html = renderReceiptHtml(legacy, OPTS)
    expect(html).not.toMatch(/undefined/)
    expect(html).toContain('N$')
  })
})
