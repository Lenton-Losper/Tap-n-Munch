import {
  reapAbandonedTabs,
  ABANDONED_TAB_INACTIVE_HOURS,
  REAP_BATCH_LIMIT,
} from '@/lib/tabs/reap-abandoned-tabs'

/**
 * #333 — the rule this file exists to defend is architectural, not arithmetic.
 *
 * `reap_abandoned_tab` refuses any tab that owes money, and that refusal is the only thing standing
 * between a cron and a fabricated settlement. It works because EVERY candidate goes through it.
 * The tempting optimisation — skip the round trip for tabs this module can already tell are unpaid
 * — would quietly move the guard out of the database and into a caller that can be wrong.
 *
 * So the first test asserts the un-optimised thing: one RPC per candidate, no exceptions. It is
 * meant to fail if someone adds a filter here.
 *
 * The behaviour is proved against a real database by
 * scripts/verify-333-reap-abandoned-tabs-staging.ts (the SQL guards) and
 * scripts/verify-333-reaper-lib-staging.ts (a real run over staging's backlog). These are the
 * parts that can be checked without one.
 */

type Outcome = { reaped: boolean; reason?: string }

function fakeSupabase(candidateIds: string[], outcomes: Record<string, Outcome | 'error'>) {
  const rpcCalls: string[] = []
  const client = {
    from() {
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'lt', 'order']) {
        builder[method] = () => builder
      }
      builder.limit = () => Promise.resolve({ data: candidateIds.map((id) => ({ id })), error: null })
      return builder
    },
    rpc(_name: string, args: { p_tab_id: string }) {
      rpcCalls.push(args.p_tab_id)
      const outcome = outcomes[args.p_tab_id]
      if (outcome === 'error') return Promise.resolve({ data: null, error: { message: 'boom' } })
      return Promise.resolve({ data: outcome ?? { reaped: false, reason: 'still_active' }, error: null })
    },
  }
  return { client, rpcCalls }
}

describe('the money guard stays in the database', () => {
  it('asks the database about every candidate, including ones it could have pre-filtered', async () => {
    const ids = ['a', 'b', 'c']
    const { client, rpcCalls } = fakeSupabase(ids, {
      a: { reaped: true },
      b: { reaped: false, reason: 'money_or_review_outstanding' },
      c: { reaped: false, reason: 'still_active' },
    })

    await reapAbandonedTabs(client as never)

    expect(rpcCalls).toEqual(ids)
  })

  it('passes the threshold through rather than baking one in', async () => {
    const seen: number[] = []
    const client = {
      from: () => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'lt', 'order']) b[m] = () => b
        b.limit = () => Promise.resolve({ data: [{ id: 'a' }], error: null })
        return b
      },
      rpc: (_n: string, args: { p_inactive_hours: number }) => {
        seen.push(args.p_inactive_hours)
        return Promise.resolve({ data: { reaped: true }, error: null })
      },
    }

    await reapAbandonedTabs(client as never, 9)
    expect(seen).toEqual([9])
  })
})

describe('classifying what came back', () => {
  it('separates reaped, left-for-staff and still-active', async () => {
    const { client } = fakeSupabase(['a', 'b', 'c', 'd'], {
      a: { reaped: true },
      b: { reaped: true },
      c: { reaped: false, reason: 'money_or_review_outstanding' },
      d: { reaped: false, reason: 'still_active' },
    })

    const result = await reapAbandonedTabs(client as never)

    expect(result.reaped).toBe(2)
    expect(result.reapedTabIds).toEqual(['a', 'b'])
    expect(result.leftForStaff).toBe(1)
    expect(result.leftForStaffTabIds).toEqual(['c'])
    expect(result.stillActive).toBe(1)
  })

  it('every candidate lands in exactly one bucket', async () => {
    // A tab that fell through the classification without being counted would be invisible in the
    // cron's own output — which is how a silent skip survives.
    const { client } = fakeSupabase(['a', 'b', 'c', 'd'], {
      a: { reaped: true },
      b: 'error',
      c: { reaped: false, reason: 'money_or_review_outstanding' },
      d: { reaped: false, reason: 'not_open' },
    })

    const r = await reapAbandonedTabs(client as never)

    expect(r.reaped + r.leftForStaff + r.stillActive + r.errors).toBe(r.candidates)
  })

  it('one failing tab does not stop the rest', async () => {
    // Otherwise a single stuck row blocks every later tab on every future tick, forever.
    const { client, rpcCalls } = fakeSupabase(['a', 'b', 'c'], {
      a: 'error',
      b: { reaped: true },
      c: { reaped: true },
    })

    const result = await reapAbandonedTabs(client as never)

    expect(rpcCalls).toEqual(['a', 'b', 'c'])
    expect(result.errors).toBe(1)
    expect(result.reaped).toBe(2)
  })

  it('an unrecognised reason counts as not-reaped rather than being dropped', async () => {
    const { client } = fakeSupabase(['a'], { a: { reaped: false, reason: 'something_new' } })
    const result = await reapAbandonedTabs(client as never)
    expect(result.reaped).toBe(0)
    expect(result.stillActive).toBe(1)
  })
})

describe('the batch cap says so when it truncates', () => {
  it('flags truncation when the candidate list fills the batch', async () => {
    const ids = Array.from({ length: REAP_BATCH_LIMIT }, (_, i) => `t${i}`)
    const { client } = fakeSupabase(ids, {})
    const result = await reapAbandonedTabs(client as never)
    expect(result.truncated).toBe(true)
  })

  it('does not flag truncation on a short list', async () => {
    const { client } = fakeSupabase(['a'], { a: { reaped: true } })
    const result = await reapAbandonedTabs(client as never)
    expect(result.truncated).toBe(false)
  })
})

describe('the threshold', () => {
  it('is four hours', () => {
    // Pinned because it is a customer-visible policy, not an implementation detail: change it
    // deliberately, not by drift.
    expect(ABANDONED_TAB_INACTIVE_HOURS).toBe(4)
  })
})
