/**
 * THE END-OF-DAY CASH-UP IN THE DOWNLOADED REPORT.
 *
 * ============================================================================================
 * WHAT WAS WRONG
 * ============================================================================================
 *
 * `getReportData` has always computed `paymentMethodSplit` — method, order count, gross money —
 * and the scheduled daily email has always rendered it. The PDF and the CSV, which are what a
 * venue actually downloads, called the same function and DISCARDED it: three summary figures,
 * revenue / orders / average, and nothing about how much of it was cash.
 *
 * So closing up meant exporting the CSV and totalling the Payment Method column by hand in a
 * spreadsheet. That is a cash-up, done manually, from a report that already held the answer.
 *
 * ============================================================================================
 * THESE ASSERT NUMBERS, NOT LABELS
 * ============================================================================================
 *
 * A test that greps the CSV for "Takings by Payment Method" passes on a section whose figures are
 * all zero, or whose cash row carries the card total. The heading is asserted once, to prove the
 * section exists at all; everything after that is arithmetic.
 */
import { generateCsv } from '@/lib/reports/generate-csv'
import { generatePdfBytes } from '@/lib/reports/generate-pdf-lib'
import { PDFDocument } from 'pdf-lib'
import { cashUpReconciliation, cashUpRows } from '@/lib/reports/payment-method-split'
import type { ReportData } from '@/lib/reports/get-report-data'

const report = (over: Partial<ReportData['summary']> = {}, orders: ReportData['orders'] = []): ReportData =>
  ({
    restaurant: { name: 'Riviera', timezone: 'Africa/Windhoek' },
    filters: { startDate: '2026-09-06', endDate: '2026-09-06' },
    summary: {
      totalRevenue: 1900,
      totalOrders: 20,
      averageOrderValue: 95,
      refundedTotal: 100,
      paymentMethodSplit: [
        { method: 'card', orders: 12, gross: 1200 },
        { method: 'cash', orders: 8, gross: 800 },
      ],
      unresolvedOrders: 0,
      ...over,
    },
    orders,
    generatedAt: '2026-09-06T18:00:00.000Z',
  }) as unknown as ReportData

const csvLines = (r: ReportData) => generateCsv(r).split('\n')
const rowFor = (r: ReportData, label: string) =>
  csvLines(r).find((l) => l.startsWith(`${label},`)) ?? ''

describe('the split carries money, not just an order count', () => {
  it('reports gross AND orders for each method', () => {
    // Analytics' pie chart counts orders only; that is what made it useless for a cash-up.
    const rows = cashUpRows(report())
    expect(rows).toEqual([
      { method: 'card', label: 'Card', orders: 12, gross: 1200 },
      { method: 'cash', label: 'Cash', orders: 8, gross: 800 },
    ])
  })

  it('names an unrecorded method rather than folding it into cash', () => {
    /**
     * `unknown` is get-report-data's bucket for an order paid with no method recorded. Silently
     * calling it cash would put money in a drawer that is not there.
     */
    const rows = cashUpRows(
      report({ paymentMethodSplit: [{ method: 'unknown', orders: 2, gross: 50 }] }),
    )
    expect(rows[0].label).toBe('Unrecorded')
    expect(rows[0].label).not.toMatch(/cash/i)
  })
})

describe('the figures reconcile', () => {
  it('bridges gross takings to net revenue through refunds', () => {
    // The parts are GROSS by construction, the headline is NET. Without the bridge the section
    // reads as an arithmetic error to whoever is counting the drawer.
    const recon = cashUpReconciliation(report())
    expect(recon.grossTaken).toBe(2000)
    expect(recon.orders).toBe(20)
    expect(recon.refunded).toBe(100)
    expect(recon.net).toBe(1900)
    expect(recon.net).toBe(report().summary.totalRevenue)
  })

  it('the order count across methods equals the reported total', () => {
    const r = report()
    expect(cashUpReconciliation(r).orders).toBe(r.summary.totalOrders)
  })

  it('survives a day with no refunds', () => {
    const recon = cashUpReconciliation(report({ refundedTotal: 0, totalRevenue: 2000 }))
    expect(recon.refunded).toBe(0)
    expect(recon.net).toBe(recon.grossTaken)
  })
})

describe('the CSV carries it', () => {
  it('has a takings section', () => {
    expect(csvLines(report())).toContain('Takings by Payment Method')
  })

  it('writes each method with its own money and count', () => {
    const r = report()
    expect(rowFor(r, 'Card')).toBe('Card,12,1200.00')
    expect(rowFor(r, 'Cash')).toBe('Cash,8,800.00')
  })

  it('does not give both methods the same figure', () => {
    // The failure a label-matching test would miss entirely.
    const r = report()
    expect(rowFor(r, 'Card')).not.toBe(rowFor(r, 'Cash').replace('Cash', 'Card'))
  })

  it('writes the bridge to net revenue', () => {
    const r = report()
    expect(rowFor(r, 'Gross Taken')).toBe('Gross Taken,20,2000.00')
    expect(rowFor(r, 'Less Refunds')).toBe('Less Refunds,,-100.00')
    expect(rowFor(r, 'Net Revenue')).toBe('Net Revenue,,1900.00')
  })

  it('says so plainly on a day with no payments', () => {
    // Never an empty section: that reads as a broken report rather than a quiet day.
    const r = report({ paymentMethodSplit: [], totalOrders: 0, totalRevenue: 0, refundedTotal: 0 })
    expect(generateCsv(r)).toContain('No payments recorded')
    expect(rowFor(r, 'Gross Taken')).toBe('Gross Taken,0,0.00')
  })

  it('still writes the per-order rows underneath', () => {
    // The section is additive. Removing the detail rows would break every existing consumer.
    expect(csvLines(report())).toContain(
      'Order #,Time,Table,Customer,Items,Total (N$),Refunded Amount (N$),Payment Method,Payment Channel,Status',
    )
  })
})

describe('the PDF carries it', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      order_number: 100 + i,
      placed_at: '2026-09-06T10:00:00.000Z',
      table_number: 3,
      customer_name: 'A',
      items: 'X',
      total: 50,
      refundedAmount: 0,
      payment_method: i % 2 === 0 ? 'card' : 'cash',
      payment_channel: 'pos',
      status: 'completed',
      paymentStatus: 'paid',
    })) as unknown as ReportData['orders']

  const split = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ method: `m${i}`, orders: 1, gross: 10 }))

  const pageCount = async (r: ReportData) =>
    (await PDFDocument.load(await generatePdfBytes(r))).getPageCount()

  it('THE PAGE BUDGET FOLLOWS THE BLOCK, measured by page count', async () => {
    /**
     * buildPagePlans hardcodes the header and summary heights as literals (78 and 60). A third
     * block whose height the budget does not know about does not error — it silently OVERPRINTS
     * the first rows of the orders table, which is invisible to any assertion about bytes.
     *
     * So the height is computed once and used by both the drawer and the budget, and the property
     * is measured the only way it shows: a taller block leaves room for fewer rows on page one, so
     * the same 30 orders need one more page. If the budget stopped following the block, both of
     * these would come back equal — which is exactly what happened when this was first written as
     * `expect(bytes.byteLength).toBeGreaterThan(1000)` and a mutation setting the budget to zero
     * stayed green.
     */
    const small = await pageCount(report({ paymentMethodSplit: split(2) }, rows(30)))
    const large = await pageCount(report({ paymentMethodSplit: split(14) }, rows(30)))

    expect(small).toBe(2)
    expect(large).toBe(3)
    expect(large).toBeGreaterThan(small)
  }, 30_000)

  it('a longer split really is a taller block', () => {
    // The arithmetic the page count depends on, asserted directly so a failure above says which
    // half broke.
    const two = report()
    const three = report({
      paymentMethodSplit: [
        { method: 'card', orders: 12, gross: 1200 },
        { method: 'cash', orders: 8, gross: 800 },
        { method: 'unknown', orders: 1, gross: 40 },
      ],
    })
    expect(cashUpRows(three).length).toBe(cashUpRows(two).length + 1)
  })
})
