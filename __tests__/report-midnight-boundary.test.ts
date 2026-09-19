/**
 * F8 — THE MIDNIGHT BOUNDARY.
 *
 * A cash-up is counted against a drawer, so it must be windowed on WHEN THE MONEY ARRIVED. It was
 * windowed on when the order was PLACED, and the failure that produces is nightly and
 * self-cancelling in the way that hides it best:
 *
 *   an order placed 23:50, paid 00:10
 *     -> appears in the FIRST shift's report
 *     -> its cash is in the SECOND shift's drawer
 *     -> shift one is short by that amount, shift two is over by it
 *     -> the two errors net to zero across the day, so the daily total never reveals it
 *
 * These assert the boundary directly, as a pure function, rather than inferring it from what a
 * query returned -- the half-open comparison here is the same rule `.gte()/.lt()` applies in the
 * database, and the last test pins that they agree.
 *
 * The venue is Windhoek (UTC+2), which is the point: a UTC comparison mis-answers "did this cross
 * midnight" for every transaction between 22:00 and midnight local.
 */
import {
  crossesDateBoundary,
  dateColumnForBasis,
  fallsInWindow,
  normalizeReportDateBasis,
  REPORT_DATE_BASES,
} from '@/lib/reports/revenue-timing'

const TZ = 'Africa/Windhoek' // UTC+2, no DST

/** 2026-07-04 local day in Windhoek: 2026-07-03T22:00Z inclusive .. 2026-07-04T22:00Z exclusive. */
const DAY_START = '2026-07-03T22:00:00.000Z'
const DAY_END = '2026-07-04T22:00:00.000Z'

describe('which column a basis windows on', () => {
  it('placed is the default, and an unknown value never silently changes a report', () => {
    expect(normalizeReportDateBasis(undefined)).toBe('placed')
    expect(normalizeReportDateBasis('')).toBe('placed')
    expect(normalizeReportDateBasis('nonsense')).toBe('placed')
    // Falling back to the NEWER basis would quietly redefine what an existing report measures.
    expect(normalizeReportDateBasis('paid')).toBe('paid')
    expect(normalizeReportDateBasis('PAID')).toBe('paid')
  })

  it('maps each basis to its column', () => {
    expect(dateColumnForBasis('placed')).toBe('placed_at')
    expect(dateColumnForBasis('paid')).toBe('paid_at')
    expect(REPORT_DATE_BASES).toEqual(['placed', 'paid'])
  })
})

describe('an order placed before midnight and paid after it', () => {
  // 23:50 local on the 4th = 21:50Z. 00:10 local on the 5th = 22:10Z.
  const straddler = {
    placed_at: '2026-07-04T21:50:00.000Z',
    paid_at: '2026-07-04T22:10:00.000Z',
    payment_status: 'paid',
  }

  it('is in the 4th on the PLACED basis', () => {
    expect(fallsInWindow(straddler, 'placed', DAY_START, DAY_END)).toBe(true)
  })

  it('is NOT in the 4th on the PAID basis — its money is in the next shift’s drawer', () => {
    expect(fallsInWindow(straddler, 'paid', DAY_START, DAY_END)).toBe(false)
  })

  it('IS in the 5th on the paid basis, so it is counted exactly once, not lost', () => {
    const nextDayStart = DAY_END
    const nextDayEnd = '2026-07-05T22:00:00.000Z'
    expect(fallsInWindow(straddler, 'paid', nextDayStart, nextDayEnd)).toBe(true)
  })

  it('is flagged as crossing the boundary, so an operator can see why the two disagree', () => {
    expect(crossesDateBoundary(straddler, TZ)).toBe(true)
  })
})

describe('the ordinary case is unaffected', () => {
  const sameDay = {
    placed_at: '2026-07-04T12:00:00.000Z',
    paid_at: '2026-07-04T12:20:00.000Z',
    payment_status: 'paid',
  }

  it('falls in the day on either basis', () => {
    expect(fallsInWindow(sameDay, 'placed', DAY_START, DAY_END)).toBe(true)
    expect(fallsInWindow(sameDay, 'paid', DAY_START, DAY_END)).toBe(true)
  })

  it('is not flagged', () => {
    expect(crossesDateBoundary(sameDay, TZ)).toBe(false)
  })
})

describe('the half-open window — each transaction lands in exactly one report', () => {
  it('a payment at exactly the start instant belongs to the new day', () => {
    expect(
      fallsInWindow({ paid_at: DAY_START }, 'paid', DAY_START, DAY_END),
    ).toBe(true)
  })

  it('a payment at exactly the end instant belongs to the NEXT day, not this one', () => {
    /**
     * The alternative -- an inclusive end -- double-counts every transaction that lands on a
     * midnight tick: it appears in both nights' takings and the month over-reports.
     */
    expect(fallsInWindow({ paid_at: DAY_END }, 'paid', DAY_START, DAY_END)).toBe(false)
    expect(
      fallsInWindow({ paid_at: DAY_END }, 'paid', DAY_END, '2026-07-05T22:00:00.000Z'),
    ).toBe(true)
  })

  it('one millisecond either side falls on the expected side', () => {
    expect(
      fallsInWindow({ paid_at: '2026-07-03T21:59:59.999Z' }, 'paid', DAY_START, DAY_END),
    ).toBe(false)
    expect(
      fallsInWindow({ paid_at: '2026-07-04T21:59:59.999Z' }, 'paid', DAY_START, DAY_END),
    ).toBe(true)
  })
})

describe('the cases the brief names as hazards', () => {
  it('an UNPAID order is outside a paid-basis window — nothing was taken', () => {
    const unpaid = { placed_at: '2026-07-04T12:00:00.000Z', paid_at: null, payment_status: 'pending' }
    expect(fallsInWindow(unpaid, 'paid', DAY_START, DAY_END)).toBe(false)
    // ...but it IS a sale that was placed that day, which is why both bases exist.
    expect(fallsInWindow(unpaid, 'placed', DAY_START, DAY_END)).toBe(true)
  })

  it('a CASH order behaves identically — the basis is about time, not method', () => {
    const cash = {
      placed_at: '2026-07-04T21:50:00.000Z',
      paid_at: '2026-07-04T22:10:00.000Z',
      payment_status: 'paid',
    }
    expect(fallsInWindow(cash, 'paid', DAY_START, DAY_END)).toBe(false)
  })

  it('an unparseable timestamp is OUT, never silently in', () => {
    // A row that cannot be placed in time must not be counted into an arbitrary day.
    expect(fallsInWindow({ paid_at: 'not a date' }, 'paid', DAY_START, DAY_END)).toBe(false)
    expect(fallsInWindow({ paid_at: '' }, 'paid', DAY_START, DAY_END)).toBe(false)
    expect(crossesDateBoundary({ placed_at: 'x', paid_at: 'y' }, TZ)).toBe(false)
  })

  it('an order with no paid_at is never flagged as crossing anything', () => {
    expect(
      crossesDateBoundary({ placed_at: '2026-07-04T21:50:00.000Z', paid_at: null }, TZ),
    ).toBe(false)
  })

  it('the flag uses the VENUE’s day, not UTC', () => {
    /**
     * Placed 23:00 local (21:00Z) and paid 23:30 local (21:30Z) on the same Windhoek day. In UTC
     * both are on the 4th too, so this case agrees either way -- the one below does not.
     */
    expect(
      crossesDateBoundary(
        { placed_at: '2026-07-04T21:00:00.000Z', paid_at: '2026-07-04T21:30:00.000Z' },
        TZ,
      ),
    ).toBe(false)

    // Placed 23:30 local on the 4th (21:30Z) and paid 00:30 local on the 5th (22:30Z). The UTC
    // dates are BOTH 2026-07-04, so a UTC comparison would report no crossing. The venue's day
    // says otherwise, and the venue's day is the one the operator works.
    expect(
      crossesDateBoundary(
        { placed_at: '2026-07-04T21:30:00.000Z', paid_at: '2026-07-04T22:30:00.000Z' },
        TZ,
      ),
    ).toBe(true)
  })

  it('an unknown timezone degrades instead of throwing inside an export', () => {
    expect(() =>
      crossesDateBoundary(
        { placed_at: '2026-07-04T21:30:00.000Z', paid_at: '2026-07-05T10:00:00.000Z' },
        'Not/AZone',
      ),
    ).not.toThrow()
  })
})

describe('the cash-up asks for the paid basis, and the sales report does not', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the cash-up route requests dateBasis: paid', () => {
    expect(read('app/api/terminal/reports/cash-up/route.ts')).toMatch(/dateBasis:\s*'paid'/)
  })

  it('the Order History export does NOT — it is about orders placed', () => {
    // The brief's instruction, pinned: only change reporting where the business meaning is
    // payment timing. A blanket replacement would silently drop every unpaid order from the
    // sales export.
    expect(read('app/api/orders/history/export/route.ts')).not.toMatch(/dateBasis:\s*'paid'/)
  })

  it('the takings query windows on the basis-derived column', () => {
    const code = read('lib/reports/get-report-data.ts')
    expect(code).toMatch(/\.gte\(windowColumn,/)
    expect(code).toMatch(/\.lt\(windowColumn,/)
  })

  it('but the UNRESOLVED-ORDERS query deliberately stays on placed_at', () => {
    /**
     * The two halves window on different columns on purpose, and this pins the reason so a later
     * tidy-up cannot "fix" the inconsistency.
     *
     * `unresolvedOrders` counts orders that have NOT been paid. An unpaid order has no `paid_at`,
     * so on a paid-basis window it matches nothing -- the figure would read 0 on every cash-up,
     * for every venue, forever. It exists precisely to tell a manager closing up that money is
     * still outstanding, so silently reporting none is the worst available failure for it.
     */
    const code = read('lib/reports/get-report-data.ts')
    expect(code).toMatch(/getReportData:unresolved/)
    expect(code).toMatch(/\.gte\('placed_at', startIso\)/)
  })

  it('paid_at is SELECTED, so the boundary flag is not computed from an absent column', () => {
    // The failure mode this project has shipped before: a column that is written or filtered on
    // but never selected reads as undefined, and the feature ships inert.
    expect(read('lib/reports/get-report-data.ts')).toMatch(/select\('id, order_number, placed_at, paid_at,/)
  })
})
