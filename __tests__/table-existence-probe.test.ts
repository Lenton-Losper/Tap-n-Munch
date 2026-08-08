/**
 * Issue #169 — the table-existence probe that reported ABSENT tables as PRESENT.
 *
 * `.select('*', { head: true, count: 'exact' })` returns no error and a null count for a table
 * that does not exist on this project, so every absent table read as present. It produced a wrong
 * report on the state of production: `invoice_requests`, `order_revisions` and `refund_events`
 * were all called present when all three were absent.
 *
 * The authoritative evidence for the fix is the LIVE control,
 * `scripts/control-table-existence-probe-staging.ts`, which runs both idioms against both arms on
 * a real database. This suite is the hermetic companion: it pins the corrected semantics so the
 * `head: true` form cannot creep back into the helper, using a stub whose behaviour was copied
 * from what the live run actually returned rather than from what PostgREST is assumed to do.
 *
 * The load-bearing test is 'calibration catches a client that cannot discriminate'. Without it
 * this file would only ever confirm a probe that already works — the exact mistake #169 is about.
 */
import {
  TABLE_ABSENT_CODES,
  absentControlName,
  calibrateTableProbe,
  probeTable,
  tableExists,
  type ProbeableClient,
} from '@/lib/supabase/table-exists'

type SelectOptions = { count?: 'exact' | 'planned' | 'estimated'; head?: boolean } | undefined
type Recorded = { table: string; columns: string; options: SelectOptions; limit: number | null }

/**
 * Reproduces the two behaviours observed live against staging (mdqjpxwczrhkxkbqatqa):
 *
 *   head: true  -> absent table returns { error: null, count: null }   <- the #169 defect
 *   no head     -> absent table returns { error: { code: 'PGRST205' } }
 *
 * `present` lists the tables that exist. Anything else is absent.
 */
function stubClient(present: string[], opts: { rowCount?: number } = {}) {
  const calls: Recorded[] = []
  const rowCount = opts.rowCount ?? 204

  const client: ProbeableClient = {
    from(table: string) {
      return {
        select(columns: string, options?: SelectOptions) {
          const record: Recorded = { table, columns, options, limit: null }
          calls.push(record)
          const exists = present.includes(table)

          const settle = () => {
            if (exists) return { error: null, count: options?.count ? rowCount : null }
            if (options?.head === true) return { error: null, count: null }
            return {
              error: {
                code: 'PGRST205',
                message: `Could not find the table 'public.${table}' in the schema cache`,
              },
              count: null,
            }
          }

          return {
            limit(n: number) {
              record.limit = n
              return Promise.resolve(settle())
            },
          }
        },
      }
    },
  }

  return { client, calls }
}

/** A client that errors with something that says nothing about existence. */
function erroringClient(code: string, message: string): ProbeableClient {
  return {
    from() {
      return {
        select() {
          return { limit: () => Promise.resolve({ error: { code, message }, count: null }) }
        },
      }
    },
  }
}

describe('#169 — table existence probe', () => {
  describe('the corrected idiom', () => {
    it('does not pass head:true, which is what broke the probe', async () => {
      const { client, calls } = stubClient(['orders'])
      await probeTable(client, 'orders')
      expect(calls).toHaveLength(1)
      expect(calls[0].options?.head).toBeUndefined()
    })

    it('takes a single row rather than a HEAD request', async () => {
      const { client, calls } = stubClient(['orders'])
      await probeTable(client, 'orders')
      expect(calls[0].limit).toBe(1)
    })

    it('POSITIVE: a present table probes as present, with its row count', async () => {
      const { client } = stubClient(['orders'], { rowCount: 204 })
      const r = await probeTable(client, 'orders')
      expect(r.exists).toBe(true)
      expect(r.inconclusive).toBe(false)
      expect(r.code).toBe('ok')
      expect(r.count).toBe(204)
    })

    it('NEGATIVE: an absent table probes as absent via PGRST205', async () => {
      const { client } = stubClient(['orders'])
      const r = await probeTable(client, 'definitely_not_a_real_table_xyz')
      expect(r.exists).toBe(false)
      expect(r.inconclusive).toBe(false)
      expect(r.code).toBe('PGRST205')
    })

    it('treats 42P01 as absent too', async () => {
      const r = await probeTable(erroringClient('42P01', 'relation "public.x" does not exist'), 'x')
      expect(r.exists).toBe(false)
      expect(r.inconclusive).toBe(false)
      expect(TABLE_ABSENT_CODES).toContain(r.code)
    })
  })

  describe('an error that is not an absence code is not evidence of absence', () => {
    it('marks a permission failure inconclusive rather than absent', async () => {
      const r = await probeTable(erroringClient('42501', 'permission denied for table orders'), 'orders')
      expect(r.exists).toBe(false)
      expect(r.inconclusive).toBe(true)
    })

    it('tableExists throws on an inconclusive probe instead of reporting false', async () => {
      const db = erroringClient('42501', 'permission denied for table orders')
      await expect(tableExists(db, 'orders')).rejects.toThrow(/Inconclusive/i)
    })

    it('tableExists returns plain booleans when the probe is conclusive', async () => {
      const { client } = stubClient(['orders'])
      await expect(tableExists(client, 'orders')).resolves.toBe(true)
      await expect(tableExists(client, 'nope_not_here')).resolves.toBe(false)
    })
  })

  describe('calibration — the part that would have caught #169', () => {
    it('reports sound when the probe discriminates both ways', async () => {
      const { client } = stubClient(['orders'])
      const c = await calibrateTableProbe(client, 'orders')
      expect(c.sound).toBe(true)
      expect(c.failure).toBeNull()
      expect(c.present.exists).toBe(true)
      expect(c.absent.exists).toBe(false)
    })

    it('catches a client that cannot discriminate — a probe returning present for everything', async () => {
      const alwaysPresent: ProbeableClient = {
        from() {
          return {
            select() {
              return { limit: () => Promise.resolve({ error: null, count: null }) }
            },
          }
        },
      }
      const c = await calibrateTableProbe(alwaysPresent, 'orders')
      expect(c.sound).toBe(false)
      expect(c.failure).toMatch(/negative control failed/i)
      expect(c.failure).toMatch(/#169/)
    })

    it('catches a probe that calls everything absent', async () => {
      const { client } = stubClient([])
      const c = await calibrateTableProbe(client, 'orders')
      expect(c.sound).toBe(false)
      expect(c.failure).toMatch(/positive control failed/i)
    })

    it('flags an unexpected error code on the absent arm rather than accepting it', async () => {
      const c = await calibrateTableProbe(erroringClient('08006', 'connection failure'), 'orders')
      expect(c.sound).toBe(false)
      expect(c.failure).toMatch(/positive control failed/i)
    })

    it('uses a randomised absent-control name, so a real table can never shadow it', () => {
      const a = absentControlName()
      const b = absentControlName()
      expect(a).not.toBe(b)
      expect(a).toMatch(/^definitely_not_a_real_table_/)
    })
  })

  describe('the defect itself, reproduced', () => {
    it('head:true really does report an absent table as errorless — why the old probe lied', async () => {
      const { client } = stubClient(['orders'])
      // Calling the stub the way the old code did, bypassing probeTable.
      const res = await client.from('table_that_does_not_exist').select('*', { count: 'exact', head: true }).limit(1)
      expect(res.error).toBeNull()
      expect(res.count ?? null).toBeNull()

      // The same table through the corrected probe is correctly absent.
      const probed = await probeTable(client, 'table_that_does_not_exist')
      expect(probed.exists).toBe(false)
    })
  })
})
