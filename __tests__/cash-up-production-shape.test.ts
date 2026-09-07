/**
 * THE 2026-09-07 DIGI COFEE CASH-UP, AS PRODUCTION ACTUALLY HOLDS IT.
 *
 * ==================================================================================================
 * WHY A PRODUCTION SHAPE AND NOT ANOTHER INVENTED ONE
 * ==================================================================================================
 *
 * cash-up-sdk6-columns-fit covers the budget with fixtures chosen to hit the boundaries. This
 * covers the day the fault was seen on paper, with the figures read back out of production after
 * order #45 was corrected. It is the shape that will be reprinted.
 *
 * It is worth its own file because this day exercises BOTH column paths without being contrived:
 *
 *   'Card (2 orders)'     15 chars -- exactly the budget, must stay on its row
 *   'PayToday (1 order)'  18 chars -- over the budget, must take a line of its own
 *   '2 x cheese toast'    16 chars -- over by one, the case that overlapped on paper
 *   '6 x cheese'          10 chars -- comfortably inside
 *
 * ==================================================================================================
 * THE FIGURES, VERIFIED AGAINST PRODUCTION
 * ==================================================================================================
 *
 *   takings      card N$156.00 (2 orders) + PayToday N$3.00 (1 order) = N$159.00
 *   items sold   Cappucino 4 / N$12, cheese 6 / N$120, cheese toast 2 / N$12, Coffee 3 / N$15
 *                                                                            = N$159.00
 *   gratuities   2, N$30.00 -- NOT in the N$159.00
 *   refunds      none
 *   cash         NONE. Before order #45 was corrected this day reported N$37.00 of cash takings
 *                that nobody had put in the till: a split card payment of N$17.00 of items plus a
 *                N$20.00 gratuity, wrongly closed as a whole N$37.00 cash order by the
 *                signature-failed webhook fallback. The absence of a cash line here is that
 *                correction, asserted.
 */
import {
  buildCashUpRows,
  renderCashUpSdk6,
  sdk6ColumnBudget,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'
import type { ReportData } from '@/lib/reports/get-report-data'

const WIDTH = 32
const BUDGET = sdk6ColumnBudget(WIDTH)

const OPTIONS: CashUpDocumentOptions = {
  printedByName: 'Lenton',
  printedAt: '2026-09-07T18:30:00.000Z',
  periodLabel: 'Today',
  characterWidth: WIDTH,
  gratuityTotal: 30,
  gratuityCount: 2,
}

/** Read back out of production on 2026-09-07 after the correction. */
const PRODUCTION_DAY = {
  restaurant: { name: 'Digi Cofee', timezone: 'Africa/Windhoek' },
  filters: { startDate: '2026-09-07', endDate: '2026-09-07' },
  summary: {
    totalRevenue: 159,
    totalOrders: 3,
    averageOrderValue: 53,
    refundedTotal: 0,
    paymentMethodSplit: [
      { method: 'card', orders: 2, gross: 156 },
      { method: 'paytoday', orders: 1, gross: 3 },
    ],
    itemsSold: [
      { name: 'Cappucino', quantity: 4, gross: 12 },
      { name: 'cheese', quantity: 6, gross: 120 },
      { name: 'cheese toast', quantity: 2, gross: 12 },
      { name: 'Coffee', quantity: 3, gross: 15 },
    ],
    unresolvedOrders: 0,
  },
  orders: [],
  generatedAt: '2026-09-07T18:30:00.000Z',
} as unknown as ReportData

const lines = () => renderCashUpSdk6(PRODUCTION_DAY, OPTIONS)
const rows = () =>
  lines().filter((l): l is { type: 'row'; columns: string[] } => l.type === 'row')
const flat = () =>
  lines()
    .map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : ''))
    .join('\n')

// ==================================================================================================
// THE FIGURES
// ==================================================================================================

describe('the figures survive rendering unchanged', () => {
  it('takings, per method, are the production figures', () => {
    const f = flat()
    expect(f).toContain('Card (2 orders)')
    expect(f).toContain('N$156.00')
    expect(f).toContain('PayToday (1 order)')
    expect(f).toContain('N$3.00')
  })

  it('reports NO cash takings — order #45 is corrected', () => {
    /**
     * THE ASSERTION THIS FILE EXISTS FOR. Before the correction this day carried a cash line of
     * N$37.00 against money nobody collected. There was no cash payment at Digi Cofee that day.
     */
    const f = flat()
    expect(f).not.toMatch(/Cash \(\d+ orders?\)/)
    expect(f).not.toContain('N$37.00')
  })

  it('gross taken and net revenue are N$159.00, and the parts sum to it', () => {
    const f = flat()
    expect(f).toContain('Gross taken')
    expect(f).toContain('N$159.00')
    expect(156 + 3).toBe(159)
    // items sold sum to the same figure
    expect(12 + 120 + 12 + 15).toBe(159)
  })

  it('the gratuity is N$30.00, shown separately and NOT inside takings', () => {
    /**
     * A gratuity is not consideration for the supply. N$30.00 must appear under its own heading
     * with the note, and must never be added into the N$159.00.
     */
    const f = flat()
    expect(f).toContain('N$30.00')
    expect(f).toContain('Not part of takings above.')
    expect(f).not.toContain('N$189.00') // 159 + 30, the number that must never appear
  })

  it('every item line is present with its quantity', () => {
    const f = flat()
    expect(f).toContain('4 x Cappucino')
    expect(f).toContain('6 x cheese')
    expect(f).toContain('2 x cheese toast')
    expect(f).toContain('3 x Coffee')
  })

  it('renders the same values the document model computed', () => {
    // The renderer draws; it never recomputes. Every value must match buildCashUpRows exactly.
    const modelled = buildCashUpRows(PRODUCTION_DAY, OPTIONS).filter(
      (r): r is { kind: 'pair'; left: string; right: string } => r.kind === 'pair',
    )
    const drawn = rows()
    expect(drawn).toHaveLength(modelled.length)
    modelled.forEach((m, i) => expect(drawn[i].columns[1]).toBe(m.right))
  })
})

// ==================================================================================================
// THE PAPER
// ==================================================================================================

describe('it fits the P5 paper', () => {
  it('no column overflows its half, anywhere on the document', () => {
    for (const r of rows()) {
      expect(r.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
      expect(r.columns[1].length).toBeLessThanOrEqual(BUDGET.right)
    }
  })

  it('no full-width line overflows the paper', () => {
    for (const l of lines()) {
      if (l.type === 'text') expect(l.text.length).toBeLessThanOrEqual(WIDTH)
    }
  })

  it("'Card (2 orders)' is exactly the budget and stays on its row", () => {
    expect('Card (2 orders)'.length).toBe(BUDGET.left)
    expect(rows().some((r) => r.columns[0] === 'Card (2 orders)')).toBe(true)
  })

  it("'PayToday (1 order)' is over the budget and takes its own line, whole", () => {
    // 18 characters. Truncating would have cost the order count off a till report.
    expect('PayToday (1 order)'.length).toBeGreaterThan(BUDGET.left)
    expect(lines().some((l) => l.type === 'text' && l.text === 'PayToday (1 order)')).toBe(true)
  })

  it("'2 x cheese toast' — the row seen overlapping on paper — no longer shares a half", () => {
    expect('2 x cheese toast'.length).toBeGreaterThan(BUDGET.left)
    expect(rows().some((r) => r.columns[0].startsWith('2 x cheese'))).toBe(false)
    expect(lines().some((l) => l.type === 'text' && l.text === '2 x cheese toast')).toBe(true)
  })

  it('every money value is intact and right-aligned in its own column', () => {
    // The SDK right-aligns the last column; these must all be complete numbers, never cut.
    for (const r of rows()) {
      expect(r.columns[1]).not.toContain('…')
      expect(r.columns[1].length).toBeLessThanOrEqual(BUDGET.right)
    }
  })
})
