/**
 * PAYMENT SUMMARY: CASH, CARD AND PAYTODAY, EACH WITH ITS OWN TOTAL, THEN A GRAND TOTAL.
 *
 * ==================================================================================================
 * WHAT WAS ASKED FOR
 * ==================================================================================================
 *
 * The outlet manager, 2026-09-08: each method named, with its order count and its own total, then
 * a rule, then the grand total. The previous layout put all three on one line each -- "Card
 * (12 orders)" against "N$1200.00" in a sixteen-character column -- which is the row that wrapped
 * and the row a manager has to scan across while counting a drawer.
 *
 * ==================================================================================================
 * PRESENTATION ONLY, AND THAT IS LOAD-BEARING
 * ==================================================================================================
 *
 * Nothing here computes money. The blocks render cashUpRows, which get-report-data builds by
 * bucketing every PAID order on its own `orders.payment_method` -- one bucket per order, so an
 * order cannot be counted twice, and the counts are the ones that already reconcile to
 * summary.totalOrders.
 *
 * The GRAND TOTAL is cashUpReconciliation().grossTaken, computed from those same rows rather than
 * read from summary.totalRevenue. If the parts and the headline ever disagreed the slip would show
 * it, instead of hiding it behind a figure nothing printed was derived from.
 *
 * ==================================================================================================
 * THE TWO PROPERTIES THAT MATTER
 * ==================================================================================================
 *
 *   RECONCILIATION   grandTotal === cash + card + paytoday, to the cent.
 *   SEPARATION       paytoday is its own method and is never folded into mobile_money, cash or
 *                    card. That is the owner's ruling of 2026-09-09 and the reason
 *                    PAYMENT_METHOD_LABELS names it explicitly.
 *
 * Gratuities are not in any of it: they come from payment_tips, print in their own section, and
 * carry a note saying they are not part of takings.
 */
import {
  buildCashUpRows,
  renderCashUpSdk6,
  sdk6ColumnBudget,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'
import { cashUpReconciliation, cashUpRows, paymentMethodLabel } from '@/lib/reports/payment-method-split'
import type { ReportData } from '@/lib/reports/get-report-data'

const WIDTH = 32
const BUDGET = sdk6ColumnBudget(WIDTH)

type Split = Array<{ method: string; orders: number; gross: number }>

const OPTIONS = (over: Partial<CashUpDocumentOptions> = {}): CashUpDocumentOptions => ({
  printedByName: 'Lenton',
  printedAt: '2026-09-08T18:30:00.000Z',
  periodLabel: 'Today',
  characterWidth: WIDTH,
  ...over,
})

const report = (split: Split, over: Record<string, unknown> = {}): ReportData =>
  ({
    restaurant: { name: 'Digi Cofee', timezone: 'Africa/Windhoek' },
    filters: { startDate: '2026-09-08', endDate: '2026-09-08' },
    summary: {
      totalRevenue: split.reduce((s, p) => s + p.gross, 0),
      totalOrders: split.reduce((s, p) => s + p.orders, 0),
      averageOrderValue: 0,
      refundedTotal: 0,
      paymentMethodSplit: split,
      itemsSold: [],
      unresolvedOrders: 0,
      ...over,
    },
    orders: [],
    generatedAt: '2026-09-08T18:30:00.000Z',
  }) as unknown as ReportData

const flat = (r: ReportData, o = OPTIONS()) =>
  renderCashUpSdk6(r, o)
    .map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : ''))
    .join('\n')

/** The money a method's block prints, read back off the rendered document. */
function totalPrintedFor(r: ReportData, label: string, o = OPTIONS()): string | null {
  const lines = renderCashUpSdk6(r, o)
  const at = lines.findIndex((l) => l.type === 'text' && l.text === label)
  if (at === -1) return null
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.type === 'row' && l.columns[0].trim() === 'Total:') return l.columns[1]
    if (l.type === 'text' && !l.text.startsWith(' ')) break // next method block
  }
  return null
}

const grandTotalPrinted = (r: ReportData, o = OPTIONS()) =>
  renderCashUpSdk6(r, o).find(
    (l) => l.type === 'row' && l.columns[0] === 'GRAND TOTAL:',
  ) as { columns: string[] } | undefined

// ==================================================================================================
// ONE METHOD AT A TIME
// ==================================================================================================

describe('cash only', () => {
  const R = report([{ method: 'cash', orders: 8, gross: 800 }])

  it('prints a Cash block with its count and total', () => {
    const f = flat(R)
    expect(f).toContain('Cash')
    expect(f).toContain('  8 orders')
    expect(totalPrintedFor(R, 'Cash')).toBe('N$800.00')
  })

  it('the grand total equals the one block', () => {
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$800.00')
  })

  it('does not invent a Card or PayToday block', () => {
    /**
     * A method with no takings prints NOTHING rather than a zero row. At a venue that does not
     * accept PayToday a permanent "PayToday N$0.00" line asserts a method they do not have, and
     * the grand total still reconciles over what IS printed.
     */
    const f = flat(R)
    expect(f).not.toContain('PayToday')
    expect(f.split('\n').some((l) => l === 'Card')).toBe(false)
  })
})

describe('card only', () => {
  const R = report([{ method: 'card', orders: 12, gross: 1200 }])
  it('prints a Card block that reconciles', () => {
    expect(totalPrintedFor(R, 'Card')).toBe('N$1200.00')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$1200.00')
  })
})

describe('PayToday only', () => {
  const R = report([{ method: 'paytoday', orders: 3, gross: 45 }])

  it('prints a PayToday block that reconciles', () => {
    expect(totalPrintedFor(R, 'PayToday')).toBe('N$45.00')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$45.00')
  })

  it('is labelled PayToday, never mobile money and never cash', () => {
    // The owner's ruling: paytoday is its own method. Mapping it back would make a Nedbank
    // product disappear into a bucket a manager reconciles differently.
    expect(paymentMethodLabel('paytoday')).toBe('PayToday')
    const f = flat(R)
    expect(f).not.toContain('mobile_money')
    expect(f).not.toContain('Mobile Money')
    expect(f.split('\n').some((l) => l === 'Cash')).toBe(false)
  })
})

// ==================================================================================================
// ALL THREE
// ==================================================================================================

describe('cash + card + PayToday', () => {
  const SPLIT: Split = [
    { method: 'card', orders: 12, gross: 1200.5 },
    { method: 'cash', orders: 8, gross: 800.25 },
    { method: 'paytoday', orders: 3, gross: 45.25 },
  ]
  const R = report(SPLIT)

  it('gives each method its own block, with its own subtotal', () => {
    expect(totalPrintedFor(R, 'Card')).toBe('N$1200.50')
    expect(totalPrintedFor(R, 'Cash')).toBe('N$800.25')
    expect(totalPrintedFor(R, 'PayToday')).toBe('N$45.25')
  })

  it('RECONCILES: grand total === cash + card + paytoday, to the cent', () => {
    /**
     * THE LOAD-BEARING ASSERTION. Deliberately awkward figures -- .50, .25, .25 -- because a
     * layout that summed major-unit floats would land on 2046.0000000000002 and this is where
     * that would show.
     */
    const cents = SPLIT.reduce((c, p) => c + Math.round(p.gross * 100), 0)
    expect(cents).toBe(204600)
    expect(cashUpReconciliation(R).grossTaken).toBe(2046)
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$2046.00')
  })

  it('counts every order exactly once across the blocks', () => {
    // get-report-data buckets each paid order on its own payment_method, so the counts partition
    // the orders. This asserts the partition survives to the paper.
    expect(cashUpReconciliation(R).orders).toBe(R.summary.totalOrders)
    expect(12 + 8 + 3).toBe(23)
    const f = flat(R)
    expect(f).toContain('  12 orders')
    expect(f).toContain('  8 orders')
    expect(f).toContain('  3 orders')
  })

  it('keeps the three methods distinct in the canonical rows', () => {
    const methods = cashUpRows(R).map((r) => r.method)
    expect(new Set(methods).size).toBe(3)
    expect(methods).toEqual(expect.arrayContaining(['cash', 'card', 'paytoday']))
  })
})

// ==================================================================================================
// GRATUITIES STAY OUT
// ==================================================================================================

describe('gratuities', () => {
  const R = report([
    { method: 'card', orders: 2, gross: 156 },
    { method: 'paytoday', orders: 1, gross: 3 },
  ])

  it('are NOT added into the grand total', () => {
    const withTips = OPTIONS({ gratuityTotal: 30, gratuityCount: 2 })
    const f = flat(R, withTips)
    expect(grandTotalPrinted(R, withTips)?.columns[1]).toBe('N$159.00')
    expect(f).not.toContain('N$189.00') // 159 + 30, the figure that must never appear
    expect(f).toContain('Not part of takings above.')
  })

  it('the grand total is identical with and without a gratuity', () => {
    // The clearest statement of the rule: adding a tip changes nothing above the rule line.
    const without = grandTotalPrinted(R)?.columns[1]
    const with_ = grandTotalPrinted(R, OPTIONS({ gratuityTotal: 30, gratuityCount: 2 }))?.columns[1]
    expect(with_).toBe(without)
  })
})

// ==================================================================================================
// EMPTY, ZERO AND UNKNOWN
// ==================================================================================================

describe('zero-value and missing methods', () => {
  it('a day with no payments prints the quiet-day line, not an empty section', () => {
    const R = report([], { totalRevenue: 0, totalOrders: 0 })
    const f = flat(R)
    expect(f).toContain('No payments recorded')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$0.00')
  })

  it('a method that took nothing but has orders still prints, and adds nothing', () => {
    // A refunded-to-zero method is a real answer, and dropping it would break the order count.
    const R = report([
      { method: 'card', orders: 2, gross: 100 },
      { method: 'cash', orders: 1, gross: 0 },
    ])
    expect(totalPrintedFor(R, 'Cash')).toBe('N$0.00')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$100.00')
  })

  it('an order paid with no method recorded is Unrecorded, never folded into cash', () => {
    /**
     * get-report-data buckets an empty payment_method as 'unknown'. A manager counting a drawer
     * would assume anything less explicit than this was cash.
     */
    const R = report([
      { method: 'cash', orders: 1, gross: 50 },
      { method: 'unknown', orders: 1, gross: 20 },
    ])
    const f = flat(R)
    expect(f).toContain('Unrecorded')
    expect(totalPrintedFor(R, 'Cash')).toBe('N$50.00')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$70.00')
  })

  it('a method the labels do not know prints its raw key rather than vanishing', () => {
    // Dropping it would make the blocks stop summing to the grand total.
    const R = report([{ method: 'eft', orders: 1, gross: 25 }])
    expect(flat(R)).toContain('eft')
    expect(grandTotalPrinted(R)?.columns[1]).toBe('N$25.00')
  })
})

// ==================================================================================================
// THE PAPER
// ==================================================================================================

describe('it still fits the printer', () => {
  const R = report([
    { method: 'card', orders: 12, gross: 1200.5 },
    { method: 'cash', orders: 8, gross: 800.25 },
    { method: 'paytoday', orders: 3, gross: 45.25 },
  ])

  it('no column overflows its half and no line overflows the paper', () => {
    for (const l of renderCashUpSdk6(R, OPTIONS())) {
      if (l.type === 'row') {
        expect(l.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
        expect(l.columns[1].length).toBeLessThanOrEqual(BUDGET.right)
      }
      if (l.type === 'text') expect(l.text.length).toBeLessThanOrEqual(WIDTH)
    }
  })

  it('every money figure is intact, never truncated', () => {
    for (const l of renderCashUpSdk6(R, OPTIONS())) {
      if (l.type === 'row') expect(l.columns[1]).not.toContain('…')
    }
  })

  it('the model and the render agree row for row', () => {
    const modelled = buildCashUpRows(R, OPTIONS()).filter((x) => x.kind === 'pair')
    const drawn = renderCashUpSdk6(R, OPTIONS()).filter((l) => l.type === 'row')
    expect(drawn).toHaveLength(modelled.length)
  })
})
