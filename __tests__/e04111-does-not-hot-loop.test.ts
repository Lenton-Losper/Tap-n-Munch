/**
 * A PERMANENT GATEWAY ANSWER MUST NOT BE ASKED AGAIN EVERY TWO MINUTES.
 *
 * ==================================================================================================
 * WHAT PRODUCTION WAS DOING
 * ==================================================================================================
 *
 * 2026-09-07, a twenty-five minute window: 273 `payment.verification_skipped` rows across 51
 * orders at four venues, some carrying 57 observations. Every one of them E04111 -- the gateway
 * saying it has NO RECORD of that merchant order number.
 *
 * The rest interval was already there and set to an hour. It did not work, and the audit rows say
 * why: order 76196885 was skipped at 12:20:37 and again at 12:22:38, two minutes apart, while
 * reporting `observationCount: 0`. A count of zero for an order skipped two minutes earlier is not
 * a quiet order. It is a read that returned none of its rows.
 *
 * TWO FAULTS, AND EITHER ALONE WOULD KEEP THE LOOP:
 *
 *   1. The throttle read fetched every historical skip row -- no created_at filter, no order, no
 *      limit -- and filtered in memory. PostgREST caps the response, so once an order accumulated
 *      history the rows the throttle needed were the ones dropped. The order read as never probed,
 *      was probed, wrote another row, and made the truncation worse. A throttle that decays as it
 *      is used is not a throttle.
 *
 *   2. E04111 is permanent. Even with a working hourly interval this is still a loop, just slower:
 *      asking again in an hour cannot produce a different answer, and the rule that consumes these
 *      observations already requires them E04111_MIN_OBSERVATION_SEPARATION_MS apart before it will
 *      conclude anything. Probing more often than that cannot advance any decision.
 *
 * ==================================================================================================
 * WHAT IS DELIBERATELY NOT CHANGED
 * ==================================================================================================
 *
 * Nothing is resolved, cancelled or marked paid. The interval decides only WHEN to ask again. An
 * order that is due is treated exactly as before, one that is not due is left untouched and
 * reported separately, and the order and its audit trail stay intact for manual resolution. No new
 * constant was invented: E04111 rests for the separation its own persistence rule already
 * requires.
 */
import {
  autoCancelStalePosOrders,
  SKIP_REPROBE_INTERVAL_MS,
  VERIFICATION_SKIPPED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'
import { E04111_MIN_OBSERVATION_SEPARATION_MS } from '@/lib/payments/query-finatic-order-paid'

type Row = Record<string, unknown>

const ORDER = 'order-hot-loop'
const REST = 'rest-1'

const MERCHANT_ORDER_NO = 'FT17881739827381354'

const orderRow = () => ({
  id: ORDER,
  restaurant_id: REST,
  total: 34,
  // #353: the sweep reads every channel and filters at the partition, so this is load-bearing.
  channel: 'pos',
  paycloud_merchant_order_no: MERCHANT_ORDER_NO,
})

/** Records what the audit SELECT was actually asked for, so the query itself can be asserted. */
function makeSupabase(opts: { priorSkips?: Row[] } = {}) {
  const inserted: Row[] = []
  const auditSelectFilters: Row[] = []

  const client = {
    from(table: string) {
      const state = { isAuditSelect: false, action: 'select' }
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = () => {
        if (table === 'audit_logs') state.isAuditSelect = true
        return self()
      }
      chain.insert = (row: Row) => {
        if (table === 'audit_logs') inserted.push(row)
        return { error: null }
      }
      chain.update = () => self()
      chain.eq = () => self()
      chain.lt = () => self()
      chain.in = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.gte = (column: string, value: unknown) => {
        if (table === 'audit_logs' && state.isAuditSelect) {
          auditSelectFilters.push({ column, value })
        }
        return self()
      }
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0
            ? { data: [orderRow()], error: null }
            : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && state.isAuditSelect) {
          return Promise.resolve({ data: opts.priorSkips ?? [], error: null }).then(resolve)
        }
        if (table === 'orders' && state.action === 'select') {
          return Promise.resolve({ data: [orderRow()], error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, auditSelectFilters }
}

const skipRow = (agoMs: number, isE04111: boolean): Row => ({
  entity_id: ORDER,
  created_at: new Date(Date.now() - agoMs).toISOString(),
  metadata: { isE04111, source: 'auto_cancel_cron' },
})

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

/** Finatic answering E04111: no record of that merchant order number. */
const e04111 = () => {
  throw Object.assign(
    new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'),
    { code: 'E04111' },
  )
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** The gateway call is injected, so a probe that happens is a probe we can count. */
function run(supabase: never) {
  let probes = 0
  const done = autoCancelStalePosOrders(supabase, {
    verifyWithFinatic: true,
    queryFinaticOrderPaidFn: (() => {
      probes++
      return e04111()
    }) as never,
  })
  return done.then((result) => Object.assign(result, {probeCount: probes}))
}

// ==================================================================================================
// A — the hot loop
// ==================================================================================================

describe('A. E04111', () => {
  it('does not re-probe two minutes after the last permanent answer', async () => {
    /**
     * THE PRODUCTION SEQUENCE. 12:20:37 then 12:22:38. Under an hourly interval this was already
     * meant to be deferred; under the permanent classification it rests far longer.
     */
    const { client } = makeSupabase({ priorSkips: [skipRow(2 * MINUTE, true)] })
    const result = await run(client)
    expect(result.probeCount).toBe(0) // the gateway was not asked at all
    expect(result.deferredRecentlyProbedIds).toContain(ORDER)
    expect(result.skippedUncertainIds).not.toContain(ORDER)
  })

  it('is still resting well after the ordinary hourly interval has passed', async () => {
    /**
     * THE HALF THE HOURLY INTERVAL COULD NOT DO. Six hours on, a transient failure would be due
     * again. E04111 cannot have changed -- the gateway has no record of the reference and never
     * will -- so it stays deferred.
     */
    const sixHours = 6 * HOUR
    expect(sixHours).toBeGreaterThan(SKIP_REPROBE_INTERVAL_MS)
    expect(sixHours).toBeLessThan(E04111_MIN_OBSERVATION_SEPARATION_MS)

    const { client } = makeSupabase({ priorSkips: [skipRow(sixHours, true)] })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).toContain(ORDER)
  })

  it('becomes due again once the observation separation has elapsed', async () => {
    /**
     * IT IS A REST, NOT A GRAVE. The persistence rule needs observations spaced at least this far
     * apart to reach a verdict, so the order must come back -- otherwise the E04111 machinery
     * could never gather a second observation and nothing would ever be resolved.
     */
    const { client } = makeSupabase({
      priorSkips: [skipRow(E04111_MIN_OBSERVATION_SEPARATION_MS + HOUR, true)],
    })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).not.toContain(ORDER)
  })
})

// ==================================================================================================
// B — transient
// ==================================================================================================

describe('B. a transient verification failure', () => {
  it('keeps the ordinary hourly interval, not the permanent one', async () => {
    /**
     * THE CONTROL THAT STOPS THIS BECOMING "DEFER EVERYTHING". A timeout or a 500 is not evidence
     * of anything permanent, and must come back on the existing schedule.
     */
    const { client } = makeSupabase({ priorSkips: [skipRow(2 * HOUR, false)] })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).not.toContain(ORDER)
  })

  it('still defers inside the hour', async () => {
    const { client } = makeSupabase({ priorSkips: [skipRow(30 * MINUTE, false)] })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).toContain(ORDER)
  })

  it('a row with no metadata at all is treated as transient', async () => {
    // Every row written before this change. They must not silently acquire a 24-hour rest.
    const { client } = makeSupabase({
      priorSkips: [{ entity_id: ORDER, created_at: new Date(Date.now() - 2 * HOUR).toISOString() }],
    })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).not.toContain(ORDER)
  })
})

// ==================================================================================================
// C, D, E
// ==================================================================================================

describe('C. an order never probed before', () => {
  it('is probed, and the skip is recorded', async () => {
    /**
     * THE POSITIVE CONTROL. Every assertion above is that something was DEFERRED; a change that
     * deferred everything would satisfy them all and silently stop the sweep working.
     */
    const { client, inserted } = makeSupabase({ priorSkips: [] })
    const result = await run(client)
    expect(result.deferredRecentlyProbedIds).not.toContain(ORDER)
    expect(result.skippedUncertainIds).toContain(ORDER)
    expect(inserted.some((r) => r.action === VERIFICATION_SKIPPED_ACTION)).toBe(true)
  })
})

describe('D. nothing is resolved by resting', () => {
  it('cancels nothing, marks nothing paid, and leaves the order alone', async () => {
    // E04111 means NO RECORD, never NOT PAID. A rest interval must not become a decision.
    const { client, inserted } = makeSupabase({ priorSkips: [skipRow(2 * MINUTE, true)] })
    const result = await run(client)
    expect(result.cancelledIds ?? []).toHaveLength(0)
    expect(inserted.some((r) => String(r.action).includes('cancel'))).toBe(false)
    expect(inserted.some((r) => String(r.action).includes('paid'))).toBe(false)
  })
})

describe('E. the read bounds itself in the QUERY', () => {
  it('filters created_at server-side, so the response cannot be truncated by history', async () => {
    /**
     * THE ROOT CAUSE, ASSERTED DIRECTLY. Without a created_at filter the response is capped by row
     * count and the newest rows -- the only ones the throttle depends on -- can be missing. This
     * pins that the bound is expressed to the database rather than applied after the fact.
     */
    const { client, auditSelectFilters } = makeSupabase({ priorSkips: [] })
    await run(client)
    expect(auditSelectFilters.length).toBeGreaterThan(0)
    expect(auditSelectFilters.some((f) => f.column === 'created_at')).toBe(true)
  })

  it('looks back at least as far as the widest interval it applies', async () => {
    // A lookback shorter than the permanent interval would hide the very rows that justify resting.
    const { client, auditSelectFilters } = makeSupabase({ priorSkips: [] })
    await run(client)
    const filter = auditSelectFilters.find((f) => f.column === 'created_at')!
    const lookbackMs = Date.now() - Date.parse(String(filter.value))
    expect(lookbackMs).toBeGreaterThanOrEqual(E04111_MIN_OBSERVATION_SEPARATION_MS - MINUTE)
  })
})
