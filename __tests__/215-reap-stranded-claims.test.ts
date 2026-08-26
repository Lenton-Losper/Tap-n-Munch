/**
 * #215 — the reaper for `order_requests` rows stranded in the transient `accepting` claim.
 *
 * WHAT THESE TESTS DEFEND is not "the sweep works". It is the three ways this cron could become a
 * worse bug than the one it fixes:
 *
 *   1. releasing FORWARDS to `accepted` — an order nobody decided on, and not even expressible
 *      against the order_requests_accepted_has_order CHECK;
 *   2. releasing a claim a worker is STILL HOLDING — the age predicate must be on the UPDATE, not
 *      merely on the candidate query, or a selection bug becomes a stolen live claim;
 *   3. releasing a claim whose age is UNKNOWN (`claimed_at IS NULL`) — the exact rows that exist
 *      because nothing recorded a time, which is what this issue is about.
 *
 * Hermetic: a hand-built PostgREST-shaped store, no database and no network.
 */
import {
  reapStrandedClaims,
  STRANDED_CLAIM_STALE_MINUTES,
  REAP_CLAIMS_BATCH_LIMIT,
  REAP_RELEASE_REASON,
} from '@/lib/order-requests/reap-stranded-claims'

const RESTAURANT = 'aaaaaaaa-0000-0000-0000-000000000001'

type Row = {
  id: string
  restaurant_id: string
  status: string
  claimed_at: string | null
  placed_at?: string | null
  tab_id?: string | null
  table_id?: string | null
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString()

function stranded(id: string, ageMinutes: number, over: Partial<Row> = {}): Row {
  return {
    id,
    restaurant_id: RESTAURANT,
    status: 'accepting',
    claimed_at: minutesAgo(ageMinutes),
    placed_at: minutesAgo(ageMinutes + 30),
    tab_id: 'tab-1',
    table_id: 'table-1',
    ...over,
  }
}

/**
 * A store that behaves like PostgREST for the two shapes this code uses: a filtered candidate
 * SELECT, and a conditional UPDATE whose predicates are evaluated AT WRITE TIME against the row as
 * it stands. That second property is the whole point of the harness — a mock that ignores the
 * conditions would let mutation 2 pass.
 *
 * `candidateOverride` exists to simulate a SELECTION BUG: it hands the reaper rows the real query
 * would never have returned, so the tests can prove the write refuses them anyway.
 */
function makeStore(rows: Row[], opts: { candidateOverride?: Row[]; selectError?: string; updateError?: string } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]))
  const updates: Array<{ patch: Record<string, unknown>; conditions: Record<string, unknown> }> = []
  const audits: Record<string, unknown>[] = []

  const client = {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            audits.push(row)
            return { error: null }
          },
        }
      }
      if (table !== 'order_requests') throw new Error(`unexpected table ${table}`)

      const conditions: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null

      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        update(next: Record<string, unknown>) {
          patch = next
          return builder
        },
        eq(col: string, val: unknown) {
          conditions[`eq:${col}`] = val
          return builder
        },
        lt(col: string, val: unknown) {
          conditions[`lt:${col}`] = val
          return builder
        },
        async limit() {
          if (opts.selectError) return { data: null, error: { message: opts.selectError } }
          if (opts.candidateOverride) return { data: opts.candidateOverride.map((r) => ({ ...r })), error: null }
          const cutoff = String(conditions['lt:claimed_at'] ?? '')
          const data = [...store.values()].filter(
            (r) =>
              r.status === conditions['eq:status'] &&
              r.claimed_at !== null &&
              String(r.claimed_at) < cutoff,
          )
          return { data: data.map((r) => ({ ...r })), error: null }
        },
        async maybeSingle() {
          const id = String(conditions['eq:id'] ?? '')
          const row = store.get(id) ?? null

          if (!patch) return { data: row ? { ...row } : null, error: null }

          if (opts.updateError) return { data: null, error: { message: opts.updateError } }
          updates.push({ patch, conditions: { ...conditions } })

          // PREDICATES APPLIED AT WRITE TIME, against the row as it stands right now.
          if (!row) return { data: null, error: null }
          if (conditions['eq:status'] !== undefined && row.status !== conditions['eq:status']) {
            return { data: null, error: null }
          }
          const staleBefore = conditions['lt:claimed_at']
          if (staleBefore !== undefined) {
            if (row.claimed_at === null || !(String(row.claimed_at) < String(staleBefore))) {
              return { data: null, error: null }
            }
          }

          Object.assign(row, patch)
          return { data: { id: row.id, status: row.status }, error: null }
        },
      }
      return builder
    },
  }

  return { client, store, updates, audits }
}

describe('it releases stranded claims BACKWARDS, and only backwards', () => {
  it('releases an aged claim to waiting_review — asserted against what was WRITTEN', async () => {
    const { client, store, updates } = makeStore([stranded('r1', 60)])

    const result = await reapStrandedClaims(client as never)

    expect(result.released).toBe(1)
    expect(result.releasedRequestIds).toEqual(['r1'])
    expect(store.get('r1')!.status).toBe('waiting_review')

    // Read from the WRITE, not from a canned reply — the mistake #120's test file records.
    const write = updates.find((u) => u.patch.status !== undefined)!
    expect(write.patch).toEqual({ status: 'waiting_review' })
    expect(write.patch).not.toMatchObject({ status: 'accepted' })
    expect(write.patch).not.toMatchObject({ status: 'declined' })
  })

  it('audits the release as a CRON release, naming the transition', async () => {
    const { client, audits } = makeStore([stranded('r1', 60)])
    await reapStrandedClaims(client as never)

    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      restaurant_id: RESTAURANT,
      action: 'order_request.claim_released',
      entity_type: 'order_request',
      entity_id: 'r1',
    })
    const meta = audits[0].metadata as Record<string, unknown>
    expect(meta.from).toBe('accepting')
    expect(meta.to).toBe('waiting_review')
    expect(meta.reason).toBe(REAP_RELEASE_REASON)
    // A human did not do this, and the trail must not read as though one did.
    expect(meta.surface).toBe('cron')
    // The true age of the round stays readable even though claimed_at is what was decided on.
    expect(typeof meta.placedAt).toBe('string')
  })
})

describe('the age predicate is on the WRITE, not on the candidate query', () => {
  it('refuses a claim younger than the cutoff even when it is handed one', async () => {
    // Simulates a selection bug: the candidate list contains a claim taken 30 seconds ago.
    const live = stranded('live', 0.5)
    const { client, store, updates } = makeStore([live], { candidateOverride: [live] })

    const result = await reapStrandedClaims(client as never)

    expect(result.released).toBe(0)
    expect(result.raced).toBe(1)
    expect(store.get('live')!.status).toBe('accepting')
    expect(updates).toHaveLength(0)
  })

  it('carries the cutoff into the UPDATE conditions, not only into the SELECT', async () => {
    const { client, updates } = makeStore([stranded('r1', 60)])
    await reapStrandedClaims(client as never)

    const write = updates.find((u) => u.patch.status !== undefined)!
    expect(write.conditions['eq:status']).toBe('accepting')
    expect(typeof write.conditions['lt:claimed_at']).toBe('string')
  })

  it('refuses a claim whose age is UNKNOWN (claimed_at IS NULL) — the very rows #215 is about', async () => {
    const unknown = stranded('r1', 60, { claimed_at: null })
    const { client, store } = makeStore([unknown], { candidateOverride: [unknown] })

    const result = await reapStrandedClaims(client as never)

    expect(result.released).toBe(0)
    expect(store.get('r1')!.status).toBe('accepting')
  })

  it('refuses a row that is no longer accepting, however it got into the list', async () => {
    const decided = stranded('r1', 60, { status: 'accepted' })
    const { client, store } = makeStore([decided], { candidateOverride: [decided] })

    const result = await reapStrandedClaims(client as never)

    expect(result.released).toBe(0)
    expect(store.get('r1')!.status).toBe('accepted')
  })
})

describe('the sweep itself', () => {
  it('asks about every candidate rather than pre-filtering any of them out', async () => {
    const rows = [stranded('a', 60), stranded('b', 90), stranded('c', 120)]
    const { client, store } = makeStore(rows)

    const result = await reapStrandedClaims(client as never)

    expect(result.candidates).toBe(3)
    expect(result.released).toBe(3)
    expect([...store.values()].map((r) => r.status)).toEqual([
      'waiting_review',
      'waiting_review',
      'waiting_review',
    ])
  })

  it('passes the threshold through rather than baking one in', async () => {
    // 20 minutes old: stale under a 15m threshold, fresh under a 30m one.
    const { client: a } = makeStore([stranded('r1', 20)])
    expect((await reapStrandedClaims(a as never, 15)).released).toBe(1)

    const { client: b } = makeStore([stranded('r1', 20)])
    expect((await reapStrandedClaims(b as never, 30)).released).toBe(0)
  })

  it('REFUSES a threshold below one minute rather than clamping it', async () => {
    const { client } = makeStore([stranded('r1', 60)])
    await expect(reapStrandedClaims(client as never, 0)).rejects.toThrow(/at least 1/)
  })

  it('keeps going when one request errors', async () => {
    const rows = [stranded('a', 60), stranded('b', 60)]
    const { client } = makeStore(rows, { updateError: 'deadlock detected' })

    const result = await reapStrandedClaims(client as never)

    expect(result.candidates).toBe(2)
    expect(result.errors).toBe(2)
    expect(result.released).toBe(0)
  })

  it('throws when the candidate query itself fails, rather than reporting an empty sweep', async () => {
    const { client } = makeStore([], { selectError: 'connection reset' })
    await expect(reapStrandedClaims(client as never)).rejects.toThrow(/candidate query failed/)
  })

  it('reports truncation when the batch cap is hit', async () => {
    const rows = Array.from({ length: REAP_CLAIMS_BATCH_LIMIT }, (_, i) => stranded(`r${i}`, 60))
    const { client } = makeStore(rows)

    const result = await reapStrandedClaims(client as never)
    expect(result.truncated).toBe(true)
  })
})

describe('CONTROL', () => {
  it('the default threshold is a real number of minutes and the happy path is reachable under it', async () => {
    // Without this, every refusal above could pass because the reaper always refuses.
    expect(STRANDED_CLAIM_STALE_MINUTES).toBeGreaterThanOrEqual(1)
    const { client } = makeStore([stranded('r1', STRANDED_CLAIM_STALE_MINUTES + 1)])
    expect((await reapStrandedClaims(client as never)).released).toBe(1)
  })
})
