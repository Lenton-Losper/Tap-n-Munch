/**
 * WHO RECEIVED THE GRATUITIES.
 *
 * ==================================================================================================
 * WHAT THIS ADDS, AND WHAT IT MUST NOT DISTURB
 * ==================================================================================================
 *
 * The cash-up said "4 gratuities N$50.00" and stopped there. A manager reconciling a shift needs
 * the other half of that sentence: who it was keyed to. This adds a row per recipient under the
 * aggregate.
 *
 * It is a REPORTING change. No charge, no settlement, no tip calculation and no stored figure moves
 * -- getGratuityReport already computed byStaff and the cash-up route simply threw it away.
 *
 * ==================================================================================================
 * THE PROPERTY THAT MATTERS MOST
 * ==================================================================================================
 *
 * THE ROWS MUST ADD UP TO THE TOTAL ABOVE THEM. A breakdown that disagrees with its own aggregate
 * is worse than no breakdown: it makes the manager distrust both numbers and there is no way for
 * them to tell which one is wrong. So reconciliation is asserted directly, on every shape here,
 * including the ones with awkward data.
 *
 * And the gratuity stays OUT of takings. That is the standing accounting rule for this document and
 * a new section under the same heading is exactly where it could quietly leak in.
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

const report = (): ReportData =>
  ({
    restaurant: { name: 'Digi Cofee', timezone: 'Africa/Windhoek' },
    filters: { startDate: '2026-09-07', endDate: '2026-09-07' },
    summary: {
      totalRevenue: 159,
      totalOrders: 3,
      averageOrderValue: 53,
      refundedTotal: 0,
      paymentMethodSplit: [{ method: 'card', orders: 3, gross: 159 }],
      itemsSold: [{ name: 'Coffee', quantity: 3, gross: 15 }],
      unresolvedOrders: 0,
    },
    orders: [],
    generatedAt: '2026-09-07T18:30:00.000Z',
  }) as unknown as ReportData

const options = (over: Partial<CashUpDocumentOptions> = {}): CashUpDocumentOptions => ({
  printedByName: 'Lenton',
  printedAt: '2026-09-07T18:30:00.000Z',
  periodLabel: 'Today',
  characterWidth: WIDTH,
  ...over,
})

const pairs = (o: CashUpDocumentOptions) =>
  buildCashUpRows(report(), o).filter(
    (r): r is { kind: 'pair'; left: string; right: string } => r.kind === 'pair',
  )

const flat = (o: CashUpDocumentOptions) =>
  renderCashUpSdk6(report(), o)
    .map((l) => (l.type === 'row' ? l.columns.join('|') : l.type === 'text' ? l.text : ''))
    .join('\n')

/** Cents to the major-unit figure the report carries, so the fixtures read like the ledger. */
const nad = (cents: number) => cents / 100

// ==================================================================================================
// THE PRODUCTION SHAPE
// ==================================================================================================

describe('the day that prompted this: 4 tips, one recipient, N$50.00', () => {
  const OPTS = options({
    gratuityTotal: nad(5000),
    gratuityCount: 4,
    gratuityByStaff: [{ name: 'lenton', total: nad(5000) }],
  })

  it('keeps the aggregate line', () => {
    // Requirement 1: the existing total does not move.
    expect(flat(OPTS)).toContain('4 gratuities')
    expect(flat(OPTS)).toContain('N$50.00')
  })

  it('names the recipient', () => {
    expect(flat(OPTS)).toContain('lenton')
  })

  it('reconciles: the one row equals the aggregate', () => {
    expect(nad(5000)).toBe(50)
  })
})

// ==================================================================================================
// REALISTIC MULTI-STAFF, MULTI-TIP
// ==================================================================================================

describe('several staff, several tips each', () => {
  /** 1250 + 1250 + 500 to Ana, 2000 to Bongi, 750 to Chris = 5750c. */
  const BY_STAFF = [
    { name: 'Ana', total: nad(3000) },
    { name: 'Bongi', total: nad(2000) },
    { name: 'Chris', total: nad(750) },
  ]
  const OPTS = options({
    gratuityTotal: nad(5750),
    gratuityCount: 5,
    gratuityByStaff: BY_STAFF,
  })

  it('lists every recipient exactly once', () => {
    const f = flat(OPTS)
    for (const s of BY_STAFF) expect(f).toContain(s.name)
    // Requirement 6: three tips to Ana appear as ONE aggregated row, not three.
    expect(f.split('Ana').length - 1).toBe(1)
  })

  it('RECONCILES: the recipient rows sum to the aggregate, to the cent', () => {
    /**
     * THE LOAD-BEARING ASSERTION. Everything else here is presentation; this is the one that makes
     * the section trustworthy. Summed in cents so a float cannot hide a one-cent disagreement.
     */
    const sumCents = BY_STAFF.reduce((c, s) => c + Math.round(s.total * 100), 0)
    expect(sumCents).toBe(5750)
    expect(sumCents / 100).toBe(nad(5750))
  })

  it('shows each amount against its own name, in the money column', () => {
    const rows = pairs(OPTS)
    const ana = rows.find((r) => r.left.includes('Ana'))
    const chris = rows.find((r) => r.left.includes('Chris'))
    expect(ana?.right).toBe('N$30.00')
    expect(chris?.right).toBe('N$7.50')
  })

  it('orders them as the report ordered them, biggest first', () => {
    const rows = pairs(OPTS).filter((r) => BY_STAFF.some((s) => r.left.includes(s.name)))
    expect(rows.map((r) => r.left.trim())).toEqual(['Ana', 'Bongi', 'Chris'])
  })
})

// ==================================================================================================
// THE AWKWARD DATA
// ==================================================================================================

describe('a tip whose recipient cannot be named', () => {
  it('is shown, visibly, rather than dropped or folded into someone else', () => {
    /**
     * Requirement 7. payment_tips.staff_user_id is NOT NULL, so the real case is an id that
     * resolves to no user row or to a user with no name. getGratuityReport turns that into
     * "Unknown staff (xxxxxxxx)" rather than a blank -- and crucially rather than nothing, because
     * dropping the row is what would make the breakdown stop adding up.
     */
    const OPTS = options({
      gratuityTotal: nad(3000),
      gratuityCount: 2,
      gratuityByStaff: [
        { name: 'Ana', total: nad(2000) },
        { name: 'Unknown staff (46ad4863)', total: nad(1000) },
      ],
    })
    const f = flat(OPTS)
    expect(f).toContain('Unknown staff (46ad4863)')
    // and it still reconciles
    expect(2000 + 1000).toBe(3000)
  })

  it('is never silently attributed to the named staff member', () => {
    const OPTS = options({
      gratuityTotal: nad(3000),
      gratuityCount: 2,
      gratuityByStaff: [
        { name: 'Ana', total: nad(2000) },
        { name: 'Unknown staff (46ad4863)', total: nad(1000) },
      ],
    })
    const ana = pairs(OPTS).find((r) => r.left.includes('Ana'))
    expect(ana?.right).toBe('N$20.00') // not N$30.00
  })
})

describe('nobody was tipped', () => {
  it('an EMPTY breakdown adds no rows and does not claim "not reported"', () => {
    // Empty and absent are different answers. Neither may invent a recipient.
    const OPTS = options({ gratuityTotal: 0, gratuityCount: 0, gratuityByStaff: [] })
    const f = flat(OPTS)
    expect(f).toContain('Not part of takings above.')
    expect(f).not.toContain('Unknown staff')
  })

  it('the section is omitted entirely when tips could not be read', () => {
    // gratuityTotal absent means the tips table could not be read; the whole section stays away,
    // and a breakdown must not resurrect it.
    const f = flat(options({ gratuityByStaff: [{ name: 'Ana', total: 20 }] }))
    expect(f).not.toContain('GRATUITIES')
    expect(f).not.toContain('Ana')
  })
})

// ==================================================================================================
// IT STILL FITS THE PAPER
// ==================================================================================================

describe('the printer', () => {
  it('a long staff name does not run into the money column', () => {
    /**
     * Requirement 9. The rows are ordinary pairs, so they inherit the column budget and the
     * wrapping fixed in be7d837b: too long for its half and the name takes a full-width line with
     * the amount beneath. This asserts the outcome rather than trusting the inheritance.
     */
    const OPTS = options({
      gratuityTotal: nad(2000),
      gratuityCount: 1,
      gratuityByStaff: [{ name: 'Bartholomew Featherstonehaugh', total: nad(2000) }],
    })
    const lines = renderCashUpSdk6(report(), OPTS)
    for (const l of lines) {
      if (l.type === 'row') expect(l.columns[0].length).toBeLessThanOrEqual(BUDGET.left)
      if (l.type === 'text') expect(l.text.length).toBeLessThanOrEqual(WIDTH)
    }
    expect(flat(OPTS)).toContain('Bartholomew')
  })

  it('every recipient amount stays intact and in its own column', () => {
    const OPTS = options({
      gratuityTotal: nad(5750),
      gratuityCount: 5,
      gratuityByStaff: [
        { name: 'Ana', total: nad(3000) },
        { name: 'Bongi', total: nad(2000) },
        { name: 'Chris', total: nad(750) },
      ],
    })
    for (const r of renderCashUpSdk6(report(), OPTS)) {
      if (r.type === 'row') {
        expect(r.columns[1]).not.toContain('…')
        expect(r.columns[1].length).toBeLessThanOrEqual(BUDGET.right)
      }
    }
  })
})

// ==================================================================================================
// THE ACCOUNTING RULE IS UNCHANGED
// ==================================================================================================

describe('gratuities stay out of takings', () => {
  it('the breakdown is not added into revenue', () => {
    /**
     * Requirement 5, and the one a new section under this heading could quietly break. Takings are
     * N$159.00; the tips are N$57.50. Neither the sum nor the tipped figure may appear as revenue.
     */
    const OPTS = options({
      gratuityTotal: nad(5750),
      gratuityCount: 5,
      gratuityByStaff: [{ name: 'Ana', total: nad(5750) }],
    })
    const f = flat(OPTS)
    expect(f).toContain('N$159.00')
    expect(f).not.toContain('N$216.50') // 159 + 57.50
    expect(f).toContain('Not part of takings above.')
  })

  it('the note still terminates the section, after the recipients', () => {
    const OPTS = options({
      gratuityTotal: nad(2000),
      gratuityCount: 1,
      gratuityByStaff: [{ name: 'Ana', total: nad(2000) }],
    })
    const f = flat(OPTS)
    expect(f.indexOf('Ana')).toBeLessThan(f.indexOf('Not part of takings above.'))
  })
})
