/**
 * THE SIGNED CASH-UP SLIP COPY. SIGNED BY THE OWNER 2026-09-06.
 *
 * Thirteen strings, printed on paper a venue keeps, files, and occasionally hands to somebody.
 * Pinned as written so a tidy-up, a refactor, or someone "improving" a heading fails here rather
 * than silently changing what comes out of the printer.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review: get the new
 * wording signed, change the constants in the same commit as this file, and say who signed it and
 * when.
 *
 * ============================================================================================
 * WHY THE DISCLAIMER GETS ITS OWN ASSERTIONS
 * ============================================================================================
 *
 * Owner at signing: "A document showing the day's takings with a venue name on it is exactly the
 * thing someone might present as a receipt, and the line saying it isn't one shouldn't be quietly
 * rewordable."
 *
 * So it is asserted three ways — it exists, it reaches the rendered document, and it is the LAST
 * thing on the paper. A disclaimer that survives as a constant but stops being printed is worth
 * nothing, and that is precisely the failure a string-equality test alone would miss.
 */
import * as Copy from '@/lib/reports/cash-up-copy'
import {
  buildCashUpRows,
  renderCashUpEscPos,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'
import type { ReportData } from '@/lib/reports/get-report-data'

const SIGNED_ON = '2026-09-06'

const OPTIONS: CashUpDocumentOptions = {
  printedByName: 'Lenton',
  printedAt: '2026-09-06T18:30:00.000Z',
  periodLabel: 'Today',
}

const report = (over: Partial<ReportData['summary']> = {}): ReportData =>
  ({
    restaurant: { name: 'Riviera', timezone: 'Africa/Windhoek' },
    filters: { startDate: '2026-09-06', endDate: '2026-09-06' },
    summary: {
      totalRevenue: 1900,
      totalOrders: 20,
      averageOrderValue: 95,
      refundedTotal: 100,
      paymentMethodSplit: [{ method: 'cash', orders: 8, gross: 800 }],
      itemsSold: [{ name: 'Coffee', quantity: 14, gross: 700 }],
      unresolvedOrders: 0,
      ...over,
    },
    orders: [],
    generatedAt: '2026-09-06T18:30:00.000Z',
  }) as unknown as ReportData

const printedText = (r: ReportData, o = OPTIONS) =>
  buildCashUpRows(r, o).map((row) =>
    row.kind === 'pair' ? row.left : row.kind === 'divider' ? '--' : (row as { text: string }).text,
  )

describe(`the signed cash-up slip copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(Copy.CASH_UP_HEADING).toBe('CASH-UP')
    expect(Copy.CASH_UP_TAKINGS_HEADING).toBe('TAKINGS')
    expect(Copy.CASH_UP_GRATUITIES_HEADING).toBe('GRATUITIES')
    expect(Copy.CASH_UP_ITEMS_HEADING).toBe('ITEMS SOLD')
    expect(Copy.CASH_UP_GROSS_TAKEN).toBe('Gross taken')
    expect(Copy.CASH_UP_LESS_REFUNDS).toBe('Less refunds')
    expect(Copy.CASH_UP_NET_REVENUE).toBe('Net revenue')
    expect(Copy.CASH_UP_ORDERS).toBe('Orders')
    expect(Copy.CASH_UP_GRATUITIES_NOTE).toBe('Not part of takings above.')
    expect(Copy.CASH_UP_NO_PAYMENTS).toBe('No payments recorded')
    expect(Copy.CASH_UP_NOTHING_SOLD).toBe('Nothing sold')
    expect(Copy.CASH_UP_PRINTED_BY).toBe('Printed by {name}')
    expect(Copy.CASH_UP_NOT_A_TAX_INVOICE).toBe('Not a tax invoice.')
  })

  it('thirteen strings, and no fourteenth added without a signature', () => {
    const exported = Object.keys(Copy).filter(
      (k) => typeof (Copy as Record<string, unknown>)[k] === 'string',
    )
    expect(exported).toHaveLength(13)
  })
})

describe('the disclaimer is on the paper, not just in the file', () => {
  it('reaches the rendered document', () => {
    // A constant that stopped being printed would pass every string-equality assertion above.
    expect(printedText(report())).toContain(Copy.CASH_UP_NOT_A_TAX_INVOICE)
  })

  it('is the LAST thing printed, where a reader ends up', () => {
    const rows = printedText(report())
    expect(rows[rows.length - 1]).toBe(Copy.CASH_UP_NOT_A_TAX_INVOICE)
  })

  it('survives into the ESC/POS bytes a printer actually receives', () => {
    /**
     * The document is composed once and rendered twice. This asserts the bytes, because a
     * renderer that dropped 'meta' rows would still pass every assertion made against the row
     * list — and the disclaimer is a meta row.
     */
    const bytes = Buffer.from(renderCashUpEscPos(report(), OPTIONS)).toString('ascii')
    expect(bytes).toContain('Not a tax invoice.')
  })

  it('is printed even on a period with no trade at all', () => {
    // The emptiest slip is the most plausible one to mistake for something else.
    const empty = report({
      paymentMethodSplit: [],
      itemsSold: [],
      totalRevenue: 0,
      totalOrders: 0,
      refundedTotal: 0,
    })
    expect(printedText(empty)).toContain(Copy.CASH_UP_NOT_A_TAX_INVOICE)
  })

  it('says it plainly, with no hedge that would let it read as one', () => {
    for (const weasel of [/may not/i, /might not/i, /generally/i, /usually/i, /informal/i]) {
      expect({ weasel: String(weasel), hedged: weasel.test(Copy.CASH_UP_NOT_A_TAX_INVOICE) }).toEqual(
        { weasel: String(weasel), hedged: false },
      )
    }
    expect(Copy.CASH_UP_NOT_A_TAX_INVOICE).toMatch(/^Not a tax invoice\.$/)
  })
})

describe('the rest of the slip carries its signed words', () => {
  it('prints who produced it, by name', () => {
    // WHO, not which device. The PIN exists to put a name here.
    expect(printedText(report())).toContain('Printed by Lenton')
  })

  it('the bridge lines are the signed ones', () => {
    const rows = printedText(report())
    for (const line of [Copy.CASH_UP_GROSS_TAKEN, Copy.CASH_UP_LESS_REFUNDS, Copy.CASH_UP_NET_REVENUE]) {
      expect(rows).toContain(line)
    }
  })

  it('the gratuity note is printed whenever a gratuity is', () => {
    // Without it somebody adds the tip to the takings by eye, which is the arithmetic the whole
    // separate-table design exists to prevent.
    const rows = printedText(report(), { ...OPTIONS, gratuityTotal: 120, gratuityCount: 4 })
    expect(rows).toContain(Copy.CASH_UP_GRATUITIES_HEADING)
    expect(rows).toContain(Copy.CASH_UP_GRATUITIES_NOTE)
  })

  it('every section heading appears', () => {
    const rows = printedText(report())
    expect(rows).toContain(Copy.CASH_UP_HEADING)
    expect(rows).toContain(Copy.CASH_UP_TAKINGS_HEADING)
    expect(rows).toContain(Copy.CASH_UP_ITEMS_HEADING)
  })

  it('nothing is left as a placeholder', () => {
    for (const [name, text] of Object.entries(Copy)) {
      if (typeof text !== 'string') continue
      expect({ name, placeholder: /PENDING|TODO|TBD|XXX/i.test(text) }).toEqual({
        name,
        placeholder: false,
      })
    }
  })
})
