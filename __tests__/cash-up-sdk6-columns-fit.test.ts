/**
 * THE CASH-UP MUST FIT THE PAPER ON THE P5's OWN PRINTER.
 *
 * ==================================================================================================
 * THE PHYSICAL FAULT
 * ==================================================================================================
 *
 * The printed cash-up had columns running into each other: "No payments received" over the top of
 * its amount, and item rows where quantity/name collided with the price.
 *
 * There are two renderers and only one was wrong:
 *
 *   renderCashUpEscPos   builds ONE string with twoColumnLine(left, right, width). It truncates and
 *                        pads to exactly characterWidth, so it can never overlap.
 *   renderCashUpSdk6     hands the P5 a `row` of columns. WiseSdk6PrinterModule splits the head
 *                        EVENLY -- columnWidth = CANVAS_WIDTH_DOTS / count -- and then calls
 *                        setColumnSpacing(0). Half the paper per column, no gutter, no fitting.
 *
 * At 384 dots and ~12 dots per character that is ~32 characters of paper and ~16 per column.
 * "No payments received" is 20. It overflowed into the amount's cell.
 *
 * The SDK cannot report this: #166 records it returning code 0 for every row while silently
 * dropping characters. So the budget has to be enforced before the bytes leave the server, and
 * asserted here rather than inferred from a return code.
 *
 * ==================================================================================================
 * WHAT THESE TESTS DELIBERATELY DO NOT DO
 * ==================================================================================================
 *
 * Nothing here re-checks the arithmetic. Takings, refunds, net revenue and the gratuity split are
 * computed in buildCashUpRows and covered by cash-up-terminal / cash-up-split; a second weaker copy
 * of those assertions here would be worse than none. These tests check that what is drawn FITS, and
 * that fitting it changed no value.
 */
import {
  buildCashUpRows,
  renderCashUpSdk6,
  sdk6ColumnBudget,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'
import { CASH_UP_NO_PAYMENTS } from '@/lib/reports/cash-up-copy'
import type { ReportData } from '@/lib/reports/get-report-data'

const OPTIONS: CashUpDocumentOptions = {
  printedByName: 'Lenton',
  printedAt: '2026-09-07T18:30:00.000Z',
  periodLabel: 'Today',
  // A gratuity is reported through OPTIONS, not the report summary: absent means "not reported",
  // never "nobody tipped". One N$10.00 tip, matching the printed receipt under investigation.
  gratuityTotal: 10,
  gratuityCount: 1,
}

/** 384-dot head at font size 25. The paper the P5 actually has loaded. */
const WIDTH = 32
const BUDGET = sdk6ColumnBudget(WIDTH)

const report = (over: Partial<ReportData['summary']> = {}): ReportData =>
  ({
    restaurant: { name: 'Digi Cofee', timezone: 'Africa/Windhoek' },
    filters: { startDate: '2026-09-07', endDate: '2026-09-07' },
    summary: {
      totalRevenue: 1900,
      totalOrders: 20,
      averageOrderValue: 95,
      refundedTotal: 100,
      paymentMethodSplit: [
        { method: 'card', orders: 12, gross: 1200 },
        { method: 'cash', orders: 8, gross: 800 },
      ],
      itemsSold: [
        { name: 'Coffee', quantity: 14, gross: 700 },
        { name: 'Cheese toast', quantity: 6, gross: 300 },
      ],
      unresolvedOrders: 0,
      ...over,
    },
    orders: [],
    generatedAt: '2026-09-07T18:30:00.000Z',
  }) as unknown as ReportData

const rowsOf = (r: ReportData, o: CashUpDocumentOptions = { ...OPTIONS, characterWidth: WIDTH }) =>
  renderCashUpSdk6(r, o).filter(
    (l): l is { type: 'row'; columns: string[] } => l.type === 'row',
  )

/** Every column of every row, as (left, right) pairs. */
const pairs = (r: ReportData, o?: CashUpDocumentOptions) =>
  rowsOf(r, o).map((l) => [l.columns[0], l.columns[1]] as const)

// ==================================================================================================
// THE BUDGET ITSELF
// ==================================================================================================

describe('the column budget matches the printer', () => {
  it('gives each column half the paper, with one character of gutter off the label', () => {
    // The native split is CANVAS/2 per column with setColumnSpacing(0). The gutter comes off the
    // LABEL because a truncated price is a wrong number and a truncated label is still readable.
    expect(BUDGET.right).toBe(16)
    expect(BUDGET.left).toBe(15)
    expect(BUDGET.left + BUDGET.right).toBeLessThanOrEqual(WIDTH)
  })

  it('scales with the stored terminal width rather than assuming 32', () => {
    expect(sdk6ColumnBudget(48)).toEqual({ left: 23, right: 24 })
    expect(sdk6ColumnBudget(42)).toEqual({ left: 20, right: 21 })
  })

  it('never returns a nonsense budget for an absurd width', () => {
    expect(sdk6ColumnBudget(1).left).toBeGreaterThanOrEqual(1)
    expect(sdk6ColumnBudget(0).left).toBeGreaterThanOrEqual(1)
  })
})

// ==================================================================================================
// 1-10, THE REQUIRED CASES
// ==================================================================================================

describe('every row fits its column', () => {
  it('1. the no-payments row, seen overlapping on paper', () => {
    /**
     * Twenty characters against a fifteen-character half. On the broken renderer it was handed
     * straight to a half-width cell with setColumnSpacing(0) and ran over the amount. It now takes
     * a line of its own, whole, with N$0.00 beneath it.
     */
    const r = report({ paymentMethodSplit: [] })
    const lines = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
    expect(lines.some((l) => l.type === 'text' && l.text === CASH_UP_NO_PAYMENTS)).toBe(true)
    // and nothing overflowed a column anywhere on the document
    for (const row of rowsOf(r)) expect(row.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
  })

  it('2. a normal payment row keeps its whole label', () => {
    /**
     * 'Card (12 orders)' is sixteen characters against a fifteen-character half, so it takes a
     * line of its own and the amount sits beneath it. What matters is that the ORDER COUNT
     * SURVIVES: cutting it to 'Card (12 order…' would stop the row overlapping and quietly cost a
     * manager the number they are reconciling against.
     */
    const lines = renderCashUpSdk6(report(), { ...OPTIONS, characterWidth: WIDTH })
    const flat = lines.map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : '')).join('\n')
    expect(flat).toContain('Card (12 orders)')
    expect(flat).toContain('Cash (8 orders)')
    expect(flat).not.toContain('order…')
  })

  it('3. a long item name is not crammed into half a line', () => {
    const r = report({
      itemsSold: [
        { name: 'Slow-roasted lamb shoulder with rosemary potatoes', quantity: 1, gross: 250 },
      ],
    })
    const lines = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
    const label = lines.find((l) => l.type === 'text' && l.text.includes('Slow-roasted'))
    expect(label).toBeDefined()
    // Its own full-width line, and still inside the paper.
    expect((label as { text: string }).text.length).toBeLessThanOrEqual(WIDTH)
    // Nothing was crammed into a half-width cell.
    for (const row of rowsOf(r)) expect(row.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
  })

  it('4. quantity + long item name still fits', () => {
    // The quantity prefix is part of the label, so it eats the same budget.
    const r = report({
      itemsSold: [{ name: 'Cheese toast with extra everything', quantity: 12, gross: 300 }],
    })
    const lines = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
    const flat = lines.map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : '')).join('\n')
    expect(flat).toContain('12 x Cheese toast')
    for (const row of rowsOf(r)) expect(row.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
  })

  it('5. the money value is right-aligned and never truncated in practice', () => {
    /**
     * The SDK right-aligns the last column; what this asserts is that the value always FITS, so the
     * alignment is of a complete number. A price wide enough to be cut would be a wrong figure on a
     * till report.
     */
    for (const [, right] of pairs(report())) {
      expect(right.length).toBeLessThanOrEqual(BUDGET.right)
      expect(right).not.toContain('…')
    }
  })

  it('6. the gratuity row fits', () => {
    const g = pairs(report()).find(([left]) => left.toLowerCase().includes('gratuit'))
    expect(g).toBeDefined()
    expect(g![0].length).toBeLessThanOrEqual(BUDGET.left)
    expect(g![1].length).toBeLessThanOrEqual(BUDGET.right)
  })

  it('7. every takings row fits', () => {
    for (const [left, right] of pairs(report())) {
      expect(left.length).toBeLessThanOrEqual(BUDGET.left)
      expect(right.length).toBeLessThanOrEqual(BUDGET.right)
    }
  })

  it('8. a label of exactly the budget length stays on its row', () => {
    // '1 x ' is four characters, so this name lands exactly on the boundary.
    const r = report({ itemsSold: [{ name: 'x'.repeat(BUDGET.left - 4), quantity: 1, gross: 10 }] })
    const row = rowsOf(r).find((l) => l.columns[0].startsWith('1 x '))
    expect(row).toBeDefined()
    expect(row!.columns[0].length).toBe(BUDGET.left)
  })

  it('9. a label one character over the budget moves to its own line', () => {
    /**
     * The boundary from the other side. Without this, "everything fits" could be satisfied by a
     * renderer that never put anything in a left column at all.
     */
    const r = report({ itemsSold: [{ name: 'y'.repeat(BUDGET.left - 3), quantity: 1, gross: 10 }] })
    expect(rowsOf(r).some((l) => l.columns[0].startsWith('1 x '))).toBe(false)
    const lines = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
    expect(lines.some((l) => l.type === 'text' && l.text.startsWith('1 x '))).toBe(true)
  })

  it('10. the totals still print, and print the same figures', () => {
    /**
     * THE VALUES MUST NOT HAVE MOVED. Fitting the text is a layout change; if any number here
     * differed from what buildCashUpRows computed, this would be a reporting bug wearing a
     * formatting fix.
     */
    const r = report()
    const modelled = buildCashUpRows(r, { ...OPTIONS, characterWidth: WIDTH }).filter(
      (row): row is { kind: 'pair'; left: string; right: string } => row.kind === 'pair',
    )
    const drawn = pairs(r)
    // One drawn row per modelled pair -- a wrapped label adds a text line, never a second value.
    expect(drawn).toHaveLength(modelled.length)
    modelled.forEach((row, i) => {
      // Every value is short enough to survive intact, so it must match the model exactly.
      expect(drawn[i][1]).toBe(row.right)
    })
  })
})

// ==================================================================================================
// AGAINST THE RENDERER THAT WAS ALREADY RIGHT
// ==================================================================================================

describe('compared with the ESC/POS renderer', () => {
  it('draws the same rows, in the same order, with the same values', () => {
    /**
     * THE POSITIVE CONTROL. Every assertion above is an upper bound on length, and a renderer that
     * emitted nothing at all would satisfy all of them. This pins that SDK6 still draws the whole
     * document and still carries the ESC/POS values.
     */
    const r = report()
    const modelled = buildCashUpRows(r, { ...OPTIONS, characterWidth: WIDTH }).filter(
      (row) => row.kind === 'pair',
    )
    expect(modelled.length).toBeGreaterThan(3)
    expect(pairs(r)).toHaveLength(modelled.length)
    // And every label still reaches the paper, on its row or on a line of its own.
    const flat = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
      .map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : ''))
      .join('\n')
    for (const row of modelled) expect(flat).toContain(row.left)
  })

  it('keeps the gratuity out of takings, exactly as before', () => {
    // Untouched by this change and pinned so a layout edit cannot quietly move a figure between
    // sections. The note is what tells a manager the tip is not in the numbers above it.
    const r = report()
    const all = renderCashUpSdk6(r, { ...OPTIONS, characterWidth: WIDTH })
    const flat = all
      .map((l) => (l.type === 'row' ? l.columns.join(' ') : l.type === 'text' ? l.text : ''))
      .join('\n')
    expect(flat).toContain('Not part of takings above.')
  })
})

describe('with no stored width', () => {
  it('falls back to 32 rather than to no budget at all', () => {
    // A terminal that has never had its paper width recorded must not print an unfitted receipt.
    const r = report({ itemsSold: [{ name: 'z'.repeat(60), quantity: 1, gross: 10 }] })
    const withoutWidth = renderCashUpSdk6(r, OPTIONS)
    for (const l of withoutWidth) {
      if (l.type === 'row') expect(l.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
      if (l.type === 'text') expect(l.text.length).toBeLessThanOrEqual(32)
    }
  })
})
