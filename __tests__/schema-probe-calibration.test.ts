/**
 * #169 -- the existence probe must be able to tell absent from present.
 *
 * WHY THE STUB IS THE WHOLE TEST. A unit test that only checked "PGRST205 means absent" would
 * stay green if `probeTable` went back to `{ head: true }`, because the interpretation is not
 * the part that was broken -- the QUERY SHAPE was. So this stub reproduces the asymmetry that
 * PostgREST actually exhibits on this project, verified live and recorded in #169:
 *
 *   with `head: true, count: 'exact'`  -> absent table returns NO error and a null count
 *   without `head`                     -> absent table returns PGRST205
 *
 * A stub that models that means a regression to `head: true` turns this file red. A stub that
 * just returned PGRST205 for any absent table would model a database that never had the bug,
 * and would confirm the probe rather than test it.
 *
 * `stub.calls` records the options each probe actually sent, so one test can assert the shape
 * directly as well -- belt and braces, because the shape is the thing under test.
 */
import {
  probeTable,
  probeColumn,
  calibrateSchemaProbes,
  ABSENT_CONTROL_TABLE,
  ABSENT_CONTROL_COLUMN,
  TABLE_ABSENT_CODE,
  COLUMN_ABSENT_CODE,
  type ProbeClient,
} from '@/lib/supabase/schema-probe'

const REAL_TABLES = new Set(['orders', 'restaurants'])
const REAL_COLUMNS: Record<string, Set<string>> = {
  orders: new Set(['*', 'id', 'status', 'total']),
  restaurants: new Set(['*', 'id', 'name']),
}

type Call = { table: string; columns: string; head: boolean; count?: string }

function makeStub() {
  const calls: Call[] = []

  const client: ProbeClient = {
    from(table: string) {
      return {
        select(columns: string, options?: { count?: 'exact'; head?: boolean }) {
          const head = Boolean(options?.head)
          calls.push({ table, columns, head, count: options?.count })

          const result = () => {
            if (!REAL_TABLES.has(table)) {
              // THE DEFECT, faithfully reproduced. With `head`, an absent table is
              // indistinguishable from an empty one.
              if (head) return { error: null, count: null }
              return {
                error: {
                  code: TABLE_ABSENT_CODE,
                  message: `Could not find the table 'public.${table}' in the schema cache`,
                },
                count: null,
              }
            }
            if (!REAL_COLUMNS[table].has(columns)) {
              // The column probe was sound all along: an absent column raises either way.
              return {
                error: { code: COLUMN_ABSENT_CODE, message: `column ${table}.${columns} does not exist` },
                count: null,
              }
            }
            return { error: null, count: 7 }
          }

          return { limit: (_n: number) => Promise.resolve(result()) }
        },
      }
    },
  }

  return { client, calls }
}

describe('#169 -- probeTable distinguishes absent from present', () => {
  it('reports a real table present', async () => {
    const { client } = makeStub()
    const r = await probeTable(client, 'orders')
    expect(r.present).toBe(true)
    expect(r.absent).toBe(false)
    expect(r.count).toBe(7)
  })

  it('reports an absent table ABSENT -- this is the assertion the issue is about', async () => {
    const { client } = makeStub()
    const r = await probeTable(client, ABSENT_CONTROL_TABLE)
    // Before the fix this read `present: true`, and three tables missing from production were
    // reported as applied on the strength of it.
    expect(r.present).toBe(false)
    expect(r.absent).toBe(true)
    expect(r.code).toBe(TABLE_ABSENT_CODE)
  })

  it('never sends head:true -- the shape is what was broken, so assert the shape', async () => {
    const { client, calls } = makeStub()
    await probeTable(client, 'orders')
    await probeTable(client, ABSENT_CONTROL_TABLE)
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.head === false)).toBe(true)
  })

  it('an unrecognised error is neither present nor confirmed absent', async () => {
    // The opposite failure mode: a permission error must not be read as "the table is gone".
    const client: ProbeClient = {
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ error: { code: '42501', message: 'permission denied' }, count: null }),
        }),
      }),
    }
    const r = await probeTable(client, 'orders')
    expect(r.present).toBe(false)
    expect(r.absent).toBe(false)
    expect(r.code).toBe('42501')
  })
})

describe('#169 -- probeColumn', () => {
  it('present column', async () => {
    const { client } = makeStub()
    expect((await probeColumn(client, 'orders', 'status')).present).toBe(true)
  })

  it('absent column is 42703', async () => {
    const { client } = makeStub()
    const r = await probeColumn(client, 'orders', ABSENT_CONTROL_COLUMN)
    expect(r.present).toBe(false)
    expect(r.absent).toBe(true)
    expect(r.code).toBe(COLUMN_ABSENT_CODE)
  })
})

describe('#169 -- calibration is the deliverable, not the probe', () => {
  it('calls the instrument sound when it can tell the four cases apart', async () => {
    const { client } = makeStub()
    const cal = await calibrateSchemaProbes(client, 'orders', 'id')
    expect(cal.failures).toEqual([])
    expect(cal.sound).toBe(true)
    expect(cal.lines).toHaveLength(4)
  })

  it('calls it UNSOUND against a database where absent tables read as present', async () => {
    // A stub standing in for the exact deployment behaviour #169 documents. This is the case the
    // whole file exists to catch, and calibration is what catches it before any result is read.
    const lying: ProbeClient = {
      from: (table: string) => ({
        select: (columns: string) => ({
          limit: () =>
            Promise.resolve(
              columns === '*' || REAL_COLUMNS.orders.has(columns)
                ? { error: null, count: table === 'orders' ? 7 : null }
                : { error: { code: COLUMN_ABSENT_CODE, message: 'no column' }, count: null }
            ),
        }),
      }),
    }
    const cal = await calibrateSchemaProbes(lying, 'orders', 'id')
    expect(cal.sound).toBe(false)
    expect(cal.failures.join(' ')).toContain('known-absent table probed PRESENT')
  })

  it('and unsound if the known-present control itself fails', async () => {
    const dead: ProbeClient = {
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ error: { code: 'PGRST301', message: 'JWT expired' }, count: null }),
        }),
      }),
    }
    const cal = await calibrateSchemaProbes(dead, 'orders', 'id')
    expect(cal.sound).toBe(false)
    expect(cal.failures.join(' ')).toContain('known table orders probed ABSENT')
  })
})
