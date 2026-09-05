/**
 * GRATUITIES BY STAFF MEMBER, OVER A PERIOD.
 *
 * Asserts CONDITIONS and arithmetic, not marker strings — the mistake that produced four defects
 * on 2026-09-05, every one of which looked covered.
 */
import { getGratuityReport } from '@/lib/reports/gratuity-report'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = {
  tip_cents: number
  method: string
  staff_user_id: string
  users: { full_name: string | null; name: string | null } | null
}

/** Records the query it was asked to run, so the filters are asserted rather than assumed. */
function supabaseDouble(rows: Row[]) {
  const calls: Record<string, unknown> = {}
  const builder: Record<string, unknown> = {
    select(sel: string) {
      calls.select = sel
      return builder
    },
    eq(col: string, val: unknown) {
      calls[`eq:${col}`] = val
      return builder
    },
    gte(col: string, val: unknown) {
      calls[`gte:${col}`] = val
      return builder
    },
    lt(col: string, val: unknown) {
      calls[`lt:${col}`] = val
      return Promise.resolve({ data: rows, error: null })
    },
  }
  return {
    calls,
    client: {
      from(table: string) {
        calls.table = table
        return builder
      },
    },
  }
}

const RANGE = { restaurantId: 'rest-1', fromIso: '2026-09-01T00:00:00.000Z', toIso: '2026-10-01T00:00:00.000Z' }

describe('the report sums the ledger, by staff member', () => {
  it('groups by staff and totals in integer cents', async () => {
    const { client } = supabaseDouble([
      {tip_cents: 1250, method: 'card', staff_user_id: 'u1', users: {full_name: 'Ana', name: null}},
      {tip_cents: 750, method: 'cash', staff_user_id: 'u1', users: {full_name: 'Ana', name: null}},
      {tip_cents: 500, method: 'card', staff_user_id: 'u2', users: {full_name: 'Ben', name: null}},
    ])
    const r = await getGratuityReport(client as never, RANGE)

    expect(r.totalCents).toBe(2500)
    expect(r.total).toBe(25)
    expect(r.tipCount).toBe(3)

    // Descending by amount: "who took what" wants the biggest first.
    expect(r.byStaff.map(s => s.name)).toEqual(['Ana', 'Ben'])
    expect(r.byStaff[0]).toMatchObject({tipCount: 2, totalCents: 2000, total: 20})
    expect(r.byStaff[1]).toMatchObject({tipCount: 1, totalCents: 500, total: 5})
  })

  it('the staff rows add up to the total, exactly', async () => {
    // A report whose parts do not sum to its own total is one nobody trusts again.
    const { client } = supabaseDouble([
      {tip_cents: 333, method: 'cash', staff_user_id: 'u1', users: null},
      {tip_cents: 333, method: 'cash', staff_user_id: 'u2', users: null},
      {tip_cents: 334, method: 'card', staff_user_id: 'u3', users: null},
    ])
    const r = await getGratuityReport(client as never, RANGE)
    expect(r.byStaff.reduce((s, x) => s + x.totalCents, 0)).toBe(r.totalCents)
    expect(r.byMethod.reduce((s, x) => s + x.totalCents, 0)).toBe(r.totalCents)
  })

  it('keeps a nameless staff member as a row rather than dropping the money', async () => {
    const { client } = supabaseDouble([
      {tip_cents: 100, method: 'cash', staff_user_id: 'abcdef01-2345-6789-abcd-ef0123456789', users: null},
    ])
    const r = await getGratuityReport(client as never, RANGE)
    expect(r.byStaff).toHaveLength(1)
    expect(r.byStaff[0].name).toContain('Unknown staff')
    expect(r.totalCents).toBe(100)
  })

  it('splits cash from card, because a venue reconciles them differently', async () => {
    const { client } = supabaseDouble([
      {tip_cents: 1000, method: 'cash', staff_user_id: 'u1', users: null},
      {tip_cents: 400, method: 'card', staff_user_id: 'u1', users: null},
    ])
    const r = await getGratuityReport(client as never, RANGE)
    expect(r.byMethod.find(m => m.method === 'cash')?.totalCents).toBe(1000)
    expect(r.byMethod.find(m => m.method === 'card')?.totalCents).toBe(400)
  })

  it('is empty rather than broken when nobody tipped', async () => {
    const { client } = supabaseDouble([])
    const r = await getGratuityReport(client as never, RANGE)
    expect(r.totalCents).toBe(0)
    expect(r.byStaff).toEqual([])
    expect(r.tipCount).toBe(0)
  })
})

describe('it reads the tip ledger and nothing else', () => {
  it('queries payment_tips, scoped to the venue and the period', async () => {
    const { client, calls } = supabaseDouble([])
    await getGratuityReport(client as never, RANGE)

    // Reading orders here is what would let a gratuity leak into a revenue figure.
    expect(calls.table).toBe('payment_tips')
    expect(calls['eq:restaurant_id']).toBe('rest-1')
    expect(calls['gte:recorded_at']).toBe(RANGE.fromIso)
    expect(calls['lt:recorded_at']).toBe(RANGE.toIso)
  })

  it('the module never touches orders or the revenue report', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'reports', 'gratuity-report.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/from\(['"]orders['"]\)/)
    expect(code).not.toMatch(/totalRevenue/)
    // ...while the prose says out loud that it must not, which is why comments are stripped.
    expect(src).toMatch(/NOT REVENUE/)
  })
})

describe('the route refuses a nonsense range rather than guessing', () => {
  const src = readFileSync(
    join(__dirname, '..', 'app', 'api', 'admin', 'restaurants', '[id]', 'reports', 'gratuities', 'route.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('requires both ends of the period', () => {
    expect(src).toMatch(/if \(!from \|\| !to\)/)
    expect(src).toMatch(/RANGE_REQUIRED/)
  })

  it('refuses a reversed range instead of silently swapping it', () => {
    expect(src).toMatch(/fromDate\.getTime\(\) >= toDate\.getTime\(\)/)
    expect(src).toMatch(/RANGE_REVERSED/)
  })

  it('is gated on the permission the rest of reporting already uses', () => {
    expect(src).toMatch(/PERMISSIONS\.ANALYTICS_VIEW/)
  })
})
