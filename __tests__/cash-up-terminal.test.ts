/**
 * THE TERMINAL CASH-UP: the permission, the purpose, the presets, and the printed document.
 *
 * ============================================================================================
 * THESE ASSERT CONDITIONS, NOT MARKER STRINGS
 * ============================================================================================
 *
 * A test that greps the route for `cash_up` passes when the guard around it is `if (false)`, and a
 * test that greps the document for "TAKINGS" passes when every figure under it is zero. Five
 * defects on 2026-09-05 and 09-06 came from exactly that. So: the permission is asserted through
 * the exported objects, the presets through the allow-list's effect, and the document through the
 * rows it produces.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS, ROLE_PERMISSIONS } from '@/lib/permissions'
import {
  TERMINAL_AUTHORIZATION_PURPOSES,
  resolveTerminalAuthorizationPermission,
} from '@/lib/terminal-auth/purpose-permissions'
import { PERMISSION_GROUPS } from '@/lib/restaurant-roles/permission-labels'
import {
  buildCashUpRows,
  renderCashUpEscPos,
  renderCashUpSdk6,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'
import type { ReportData } from '@/lib/reports/get-report-data'
import { aggregateItemsSold } from '@/lib/reports/items-sold'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CHECK_MIG = sql(read('supabase', 'migrations', '20260907090000_authorization_purpose_cash_up.sql'))

/**
 * The constraint AS IT ENDS UP. Each purpose migration DROPs it by name and rebuilds it whole, so
 * the live allow-list is the highest-versioned file — today that is this one, and the moment an
 * eighth purpose lands it will not be. Reading the newest is what stops this suite failing on
 * correct code the next time somebody adds a purpose.
 */
const LATEST_PURPOSE_MIG = sql(
  read(
    'supabase',
    'migrations',
    readdirSync(join(ROOT, 'supabase', 'migrations'))
      .filter((f) => /_authorization_purpose_.*\.sql$/.test(f))
      .sort()
      .at(-1)!,
  ),
)
const GRANT_MIG = sql(read('supabase', 'migrations', '20260907090100_grant_reports_cash_up.sql'))
const ROUTE = code(read('app', 'api', 'terminal', 'reports', 'cash-up', 'route.ts'))

const OPTIONS: CashUpDocumentOptions = {
  printedByName: 'Lenton',
  printedAt: '2026-09-07T18:30:00.000Z',
  periodLabel: 'Today',
}

const report = (over: Partial<ReportData['summary']> = {}): ReportData =>
  ({
    restaurant: { name: 'Riviera', timezone: 'Africa/Windhoek' },
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

const text = (r: ReportData, o = OPTIONS) =>
  buildCashUpRows(r, o).map((row) =>
    row.kind === 'pair' ? `${row.left}|${row.right}` : row.kind === 'divider' ? '--' : (row as { text: string }).text,
  )

describe('the permission is its own, and manager/owner only', () => {
  it('reports:cash_up is defined', () => {
    expect(Object.values(PERMISSIONS)).toContain('reports:cash_up')
  })

  it('owner and manager hold it; nobody else does', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('reports:cash_up')
    expect(ROLE_PERMISSIONS.manager).toContain('reports:cash_up')
    for (const role of ['cashier', 'waiter', 'kitchen', 'bar']) {
      expect({ role, has: ROLE_PERMISSIONS[role].includes('reports:cash_up' as never) }).toEqual({
        role,
        has: false,
      })
    }
  })

  it('is NOT analytics:view and NOT tabs:close_unpaid reused', () => {
    /**
     * All three land on owner+manager today, which is exactly why reusing one would be a mistake
     * nobody notices until they need to differ. Reading the day's money, opening dashboard charts,
     * and writing off a customer's debt are three authorities.
     */
    expect(PERMISSIONS.REPORTS_CASH_UP).not.toBe(PERMISSIONS.ANALYTICS_VIEW)
    expect(PERMISSIONS.REPORTS_CASH_UP).not.toBe(PERMISSIONS.TABS_CLOSE_UNPAID)
  })

  it('is offered on the staff page, so it can actually be granted', () => {
    // The defect from 2026-09-06: orders:void had a label and appeared in no group, so the page
    // rendered no checkbox and nobody could grant it.
    const offered = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key))
    expect(offered).toContain(PERMISSIONS.REPORTS_CASH_UP)
  })

  it('the data migration grants it to exactly those two roles, idempotently', () => {
    // The config file reaches NEWLY SEEDED venues only; existing rows need this or a manager's
    // correct PIN is refused.
    expect(GRANT_MIG).toMatch(/array_append\(permissions, 'reports:cash_up'\)/)
    expect(GRANT_MIG).toMatch(/role_slug IN \('manager', 'owner'\)/)
    expect(GRANT_MIG).toMatch(/NOT \(permissions @> ARRAY\['reports:cash_up'\]::text\[\]\)/)
  })
})

describe('the cash_up purpose reaches BOTH allow-lists', () => {
  it('maps to reports:cash_up', () => {
    expect(TERMINAL_AUTHORIZATION_PURPOSES.cash_up).toBe(PERMISSIONS.REPORTS_CASH_UP)
    expect(resolveTerminalAuthorizationPermission('cash_up')).toBe('reports:cash_up')
  })

  it('the database CHECK carries EVERY existing value plus cash_up', () => {
    /**
     * Forgotten four times now. When it is missed, /api/terminal/authorize passes every
     * application check and fails on the INSERT with a 23514 — a correct PIN, told authorization
     * failed, every time.
     */
    expect(CHECK_MIG).toContain(`'cash_up'::text`)
    for (const purpose of Object.keys(TERMINAL_AUTHORIZATION_PURPOSES)) {
      expect(LATEST_PURPOSE_MIG).toContain(`'${purpose}'::text`)
    }
  })

  it('the two allow-lists agree exactly — neither has a value the other lacks', () => {
    const inSql = [...LATEST_PURPOSE_MIG.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()
    const inApp = Object.keys(TERMINAL_AUTHORIZATION_PURPOSES).sort()
    expect(inSql).toEqual(inApp)
  })

  it('rebuilds the constraint whole rather than appending', () => {
    // So it can be applied whether or not the line_void migration ran first — that one ships with
    // the held amend gate.
    expect(CHECK_MIG).toMatch(/DROP CONSTRAINT IF EXISTS privileged_authorization_tokens_purpose_check/)
    expect(CHECK_MIG).toMatch(/ADD CONSTRAINT privileged_authorization_tokens_purpose_check/)
  })
})

describe('the route refuses before it reports', () => {
  it('demands a token AND a staff id', () => {
    expect(ROUTE).toMatch(/if \(!staffUserId \|\| !authorizationTokenId\)/)
    expect(ROUTE).toMatch(/CASH_UP_NEEDS_AUTHORIZATION/)
  })

  it('consumes the token against the cash_up purpose specifically', () => {
    expect(ROUTE).toMatch(/expectedPurpose: 'cash_up'/)
    // Fails closed: a thrown error is a rejection, not an escaped 401 that would evict the device.
    expect(ROUTE).toMatch(/consumed = \{ ok: false, reason: 'not_found' \}/)
    expect(ROUTE).toMatch(/if \(!consumed\.ok\)/)
  })

  it('every refusal happens BEFORE any report is built', () => {
    for (const guard of ['CASH_UP_NEEDS_AUTHORIZATION', 'AUTHORIZATION_INVALID']) {
      expect(ROUTE.indexOf(guard)).toBeGreaterThan(-1)
      expect(ROUTE.indexOf(guard)).toBeLessThan(ROUTE.indexOf('getReportData({'))
    }
  })

  it('accepts three presets and no more', () => {
    // Asserted on the allow-list's CONTENT, so widening it to thisYear fails here.
    const block = ROUTE.slice(ROUTE.indexOf('const TERMINAL_PRESETS'), ROUTE.indexOf('function isUuid'))
    const ids = [...block.matchAll(/id: '([A-Za-z]+)'/g)].map((m) => m[1]).sort()
    expect(ids).toEqual(['thisWeek', 'today', 'yesterday'])
  })

  it('takes the period from the VENUE timezone, never the device', () => {
    expect(ROUTE).toMatch(/resolveDateRangePreset\(preset\.id, \{ timeZone: timezone \}\)/)
    expect(ROUTE).toMatch(/from\('restaurants'\)/)
  })

  it('prints the name bound to the CONSUMED token, not the one in the body', () => {
    // Otherwise a caller could put somebody else's name on a document whose purpose is saying who.
    const nameLookup = ROUTE.indexOf("from('users')")
    expect(nameLookup).toBeGreaterThan(ROUTE.indexOf('if (!consumed.ok)'))
    expect(ROUTE).toMatch(/\.eq\('id', staffUserId\)/)
  })

  it('writes nothing', () => {
    // A cash-up is a read. A failed print must be a reprint, never a correction.
    expect(ROUTE).not.toMatch(/\.insert\(/)
    expect(ROUTE).not.toMatch(/\.update\(/)
    expect(ROUTE).not.toMatch(/\.upsert\(/)
    expect(ROUTE).not.toMatch(/\.delete\(/)
  })
})

describe('the printed document', () => {
  it('splits takings by method with money AND order count', () => {
    const lines = text(report())
    expect(lines).toContain('Card (12 orders)|N$1200.00')
    expect(lines).toContain('Cash (8 orders)|N$800.00')
  })

  it('bridges gross to net through refunds', () => {
    const lines = text(report())
    expect(lines).toContain('Gross taken|N$2000.00')
    expect(lines).toContain('Less refunds|N$-100.00')
    expect(lines).toContain('Net revenue|N$1900.00')
  })

  it('omits the refund line on a day with none, rather than printing a zero', () => {
    // Noise on paper somebody reads at the end of a shift.
    const lines = text(report({ refundedTotal: 0, totalRevenue: 2000 }))
    expect(lines.some((l) => l.startsWith('Less refunds'))).toBe(false)
    expect(lines).toContain('Net revenue|N$2000.00')
  })

  it('lists every item sold, uncapped, with quantities', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `Item ${i}`,
      quantity: i + 1,
      gross: 10,
    }))
    const lines = text(report({ itemsSold: many }))
    // A cash-up lists what was sold, not the highlights. The dead analytics helper was top-10.
    expect(lines).toContain('40 x Item 39|N$10.00')
    expect(lines).toContain('1 x Item 0|N$10.00')
    expect(lines.filter((l) => / x Item /.test(l))).toHaveLength(40)
  })

  it('prints gratuities BELOW the total and never inside it', () => {
    const lines = text(report(), { ...OPTIONS, gratuityTotal: 120, gratuityCount: 4 })
    expect(lines).toContain('4 gratuities|N$120.00')
    // A gratuity is not consideration for the supply. Folding it into takings here would undo the
    // whole reason it lives in its own table, outside the VAT base.
    expect(lines).toContain('Gross taken|N$2000.00')
    expect(lines).toContain('Net revenue|N$1900.00')
    expect(lines.some((l) => l.includes('N$2120.00'))).toBe(false)
  })

  it('omits gratuities entirely when they are not reported, never printing zero', () => {
    // Absent means "this venue does not report tips yet". N$0.00 would claim nobody tipped.
    const lines = text(report())
    expect(lines.some((l) => /gratuit/i.test(l))).toBe(false)
  })

  it('says who printed it and that it is not a tax invoice', () => {
    const lines = text(report())
    expect(lines).toContain('Printed by Lenton')
    expect(lines).toContain('Not a tax invoice.')
  })

  it('says so plainly on a day with no takings', () => {
    const lines = text(report({ paymentMethodSplit: [], itemsSold: [], totalRevenue: 0, totalOrders: 0, refundedTotal: 0 }))
    expect(lines.some((l) => l.startsWith('No payments recorded'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Nothing sold'))).toBe(true)
  })
})

describe('both printer formats carry the same document', () => {
  it('every figure in the rows appears in the ESC/POS bytes', () => {
    const r = report()
    const bytes = Buffer.from(renderCashUpEscPos(r, OPTIONS)).toString('ascii')
    for (const figure of ['N$1200.00', 'N$800.00', 'N$2000.00', 'N$1900.00', 'Lenton']) {
      expect({ figure, present: bytes.includes(figure) }).toEqual({ figure, present: true })
    }
  })

  it('and in the SDK6 lines', () => {
    const r = report()
    const flat = renderCashUpSdk6(r, OPTIONS)
      .map((l) => ('columns' in l ? l.columns.join(' ') : 'text' in l ? l.text : ''))
      .join('\n')
    for (const figure of ['N$1200.00', 'N$800.00', 'N$2000.00', 'N$1900.00', 'Lenton']) {
      expect({ figure, present: flat.includes(figure) }).toEqual({ figure, present: true })
    }
  })

  it('the two formats are built from ONE row list, so a figure cannot differ between printers', () => {
    /**
     * The failure this rules out is impossible to explain to somebody holding two pieces of paper
     * from the same venue. Asserted by counting: every pair row becomes exactly one SDK6 'row'.
     */
    const r = report()
    const pairs = buildCashUpRows(r, OPTIONS).filter((row) => row.kind === 'pair')
    const sdkRows = renderCashUpSdk6(r, OPTIONS).filter((l) => l.type === 'row')
    expect(sdkRows).toHaveLength(pairs.length)
  })

  it('the ESC/POS document initialises and cuts', () => {
    // Without the cut the next print runs onto the same slip; without init it inherits whatever
    // mode the previous document left the printer in.
    const bytes = renderCashUpEscPos(report(), OPTIONS)
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40])
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01])
  })
})

describe('the items-sold aggregation', () => {
  /**
   * EXTRACTED FROM getReportData SO IT COULD BE TESTED AT ALL. Written inline it needed a database
   * to reach, and a mutation sweep on 2026-09-07 proved the consequence: capping the list at ten,
   * switching the money to ex-VAT, and dropping zero-quantity lines ALL left every test green.
   * Three real defects, invisible. These are those three mutations, turned into assertions.
   */
  const order = (items: unknown) => ({ items })

  it('is UNCAPPED — a cash-up lists what was sold, not the highlights', () => {
    // The dead analytics helper is a top-10. That is right for a dashboard tile and wrong here:
    // a truncated list is one somebody reconciles against a drawer wondering what line 11 was.
    const items = Array.from({ length: 25 }, (_, i) => ({
      menu_item_id: `m${i}`,
      name: `Item ${i}`,
      quantity: 1,
      total: 5,
    }))
    expect(aggregateItemsSold([order(items)])).toHaveLength(25)
  })

  it('uses the VAT-INCLUSIVE total, so the items add up to the money taken', () => {
    /**
     * `item.total` is gross and sums to orders.total; `item.subtotal` is ex-VAT. An item list on a
     * cash-up that does not reconcile to the takings printed above it is the one thing this
     * document cannot afford.
     */
    const sold = aggregateItemsSold([
      order([{ menu_item_id: 'm1', name: 'Cheese', quantity: 1, total: 20, subtotal: 17.39 }]),
    ])
    expect(sold[0].gross).toBe(20)
    expect(sold[0].gross).not.toBe(17.39)
  })

  it('counts a missing or zero quantity as ONE, never as nothing', () => {
    // A line with no quantity is still a thing that was sold and charged for. Dropping it leaves
    // the item list short against the bill.
    const sold = aggregateItemsSold([
      order([
        { menu_item_id: 'm1', name: 'Coffee', total: 5 },
        { menu_item_id: 'm1', name: 'Coffee', quantity: 0, total: 5 },
      ]),
    ])
    expect(sold).toHaveLength(1)
    expect(sold[0].quantity).toBe(2)
  })

  it('groups the same dish across orders, by id rather than by name', () => {
    // So a dish renamed mid-period does not split into two lines on the same slip.
    const sold = aggregateItemsSold([
      order([{ menu_item_id: 'm1', name: 'Coffee', quantity: 2, total: 10 }]),
      order([{ menu_item_id: 'm1', name: 'Coffee (large)', quantity: 3, total: 15 }]),
    ])
    expect(sold).toHaveLength(1)
    expect(sold[0].quantity).toBe(5)
    expect(sold[0].gross).toBe(25)
  })

  it('sorts by quantity, then name, so the slip is stable', () => {
    const sold = aggregateItemsSold([
      order([
        { menu_item_id: 'b', name: 'Beer', quantity: 2, total: 40 },
        { menu_item_id: 'a', name: 'Ale', quantity: 2, total: 30 },
        { menu_item_id: 'c', name: 'Cider', quantity: 9, total: 90 },
      ]),
    ])
    expect(sold.map((s) => s.name)).toEqual(['Cider', 'Ale', 'Beer'])
  })

  it('handles an order with no items at all', () => {
    // QR and pre-migration orders both exist. A missing array must not throw mid-cash-up.
    expect(aggregateItemsSold([order(undefined), order(null), order('nonsense')])).toEqual([])
  })
})
