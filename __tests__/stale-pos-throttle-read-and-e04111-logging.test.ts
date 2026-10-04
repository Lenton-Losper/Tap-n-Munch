import {
  autoCancelStalePosOrders,
  SKIP_REPROBE_INTERVAL_MS,
  VERIFICATION_SKIPPED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'

/**
 * Two defects in the stale-POS sweep's E04111 handling, measured on production 2026-10-04.
 *
 * 1. THE THROTTLE READ DISCARDED ITS ERROR. The read that decides "was this order probed recently?"
 *    destructured only `data`. supabase-js does not throw on a failed request -- it RETURNS
 *    `{ data: null, error }` -- so a failed read looked exactly like "no order has ever been probed".
 *    The catch that logs "could not read prior skip audit rows" never ran, and every due order was
 *    probed again. Production: 1,220 E04111 re-probes in seven days landed less than 23 h after the
 *    previous one (the separation is 24 h), always in runs of exactly 20 -- the per-run cap -- and
 *    always the same 21 oldest orders, each row reading `observationCount: 0` minutes after the
 *    last. No log line said why. The existing fail-open test only covered the read THROWING, which
 *    is the shape the real client never produces.
 *
 *    Fail-OPEN is kept: that is a recorded decision (probe rather than defer blindly). What changes
 *    is that the failure is now visible.
 *
 * 2. E04111 WAS LOGGED AS "Finatic check failed" AT console.error. Every one of the 3,550 skip rows
 *    production wrote in those seven days was E04111 -- the gateway answering, recognisably, that it
 *    has no record of the reference. That is a classified answer, not a failed check, and logging it
 *    as an error buried the real failures (unreachable, auth, unknown errors) under it. E04111 now
 *    logs at warn with its own wording; everything else still logs "Finatic check failed" at error.
 *
 * Neither change touches a decision about money: nothing here cancels, corrects or marks paid.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-with-a-reference'
const MERCHANT_ORDER_NO = 'FT-TEST-0001'

type Row = Record<string, unknown>

const orderRow = () => ({
  id: ORDER,
  restaurant_id: RESTAURANT,
  total: 33,
  channel: 'pos',
  paycloud_merchant_order_no: MERCHANT_ORDER_NO,
})

/**
 * Same double as stale-pos-skip-is-recorded, plus `auditReadError`: the throttle read RESOLVES with
 * `{ data: null, error }`, which is what supabase-js does on a statement timeout or a failed request.
 */
function makeSupabase(opts: { priorSkips?: Row[]; auditReadError?: Row }) {
  const inserted: Row[] = []
  const updates: Row[] = []

  const client = {
    from(table: string) {
      const state = { isAuditSelect: false }
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
      chain.update = (patch: Row) => {
        updates.push({ table, ...patch })
        return self()
      }
      for (const m of ['eq', 'lt', 'gte', 'in', 'is', 'order', 'limit']) chain[m] = () => self()
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0 ? { data: [orderRow()], error: null } : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && state.isAuditSelect) {
          return Promise.resolve(
            opts.auditReadError
              ? { data: null, error: opts.auditReadError }
              : { data: opts.priorSkips ?? [], error: null },
          ).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, updates }
}

const e04111 = () => {
  throw Object.assign(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'), {
    code: 'E04111',
  })
}
const unreachable = () => {
  throw new Error('fetch failed: connect ETIMEDOUT')
}

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

const STATEMENT_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' }

let errorSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c.map(String).join(' '))

describe('the throttle read, when it RETURNS an error rather than throwing', () => {
  it('logs the failed read -- a fail-open that nobody can see is the defect', async () => {
    const { client } = makeSupabase({ auditReadError: STATEMENT_TIMEOUT })
    await autoCancelStalePosOrders(client, { verifyWithFinatic: true, queryFinaticOrderPaidFn: e04111 as never })

    const lines = logged(errorSpy).filter((l) => l.includes('could not read prior skip audit rows'))
    expect(lines).toHaveLength(1)
    // The cause must reach the log, not just the fact of failure.
    expect(lines[0]).toContain('statement timeout')
  })

  it('still fails OPEN: the order is probed, not deferred (recorded decision, unchanged)', async () => {
    let probes = 0
    const { client } = makeSupabase({ auditReadError: STATEMENT_TIMEOUT })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        probes++
        return e04111()
      }) as never,
    })
    expect(probes).toBe(1)
    expect(result.deferredRecentlyProbedIds).toHaveLength(0)
    expect(result.skippedUncertainIds).toContain(ORDER)
  })

  it('positive control: a successful read with a recent probe still defers', async () => {
    // Without this, "probes=1 after an error" could also mean the throttle is simply dead.
    const recent = new Date(Date.now() - SKIP_REPROBE_INTERVAL_MS / 2).toISOString()
    let probes = 0
    const { client } = makeSupabase({ priorSkips: [{ entity_id: ORDER, created_at: recent }] })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        probes++
        return e04111()
      }) as never,
    })
    expect(probes).toBe(0)
    expect(result.deferredRecentlyProbedIds).toContain(ORDER)
    expect(logged(errorSpy).some((l) => l.includes('could not read prior skip audit rows'))).toBe(false)
  })
})

describe('E04111 is a classified gateway answer, not a failed check', () => {
  it('logs E04111 at warn, with its own wording, and NOT as "Finatic check failed" at error', async () => {
    const { client } = makeSupabase({ priorSkips: [] })
    await autoCancelStalePosOrders(client, { verifyWithFinatic: true, queryFinaticOrderPaidFn: e04111 as never })

    expect(logged(errorSpy).some((l) => l.includes('Finatic check failed'))).toBe(false)
    const warns = logged(warnSpy).filter((l) => l.includes(ORDER) && l.includes('E04111'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('no record')
  })

  it('a genuine failure (gateway unreachable) is STILL "Finatic check failed" at error', async () => {
    // The visibility that must not be lost: reclassifying E04111 must not quiet real failures.
    const { client } = makeSupabase({ priorSkips: [] })
    await autoCancelStalePosOrders(client, { verifyWithFinatic: true, queryFinaticOrderPaidFn: unreachable as never })

    const errs = logged(errorSpy).filter((l) => l.includes('Finatic check failed') && l.includes(ORDER))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('ETIMEDOUT')
  })

  it('reclassifying the log changes nothing else: E04111 is still skipped, recorded, never cancelled or paid', async () => {
    const { client, inserted, updates } = makeSupabase({ priorSkips: [] })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: e04111 as never,
    })
    expect(result.skippedUncertainIds).toContain(ORDER)
    expect(result.e04111Ids).toContain(ORDER)
    expect(result.cancelledIds).not.toContain(ORDER)
    expect(result.correctedToPaidIds).not.toContain(ORDER)
    // Not `updates.length === 0`: this double answers every `orders` read with the order, so the
    // release pass (which runs first) sees it as held and hands it back to `pending`. That is the
    // double, not the sweep. What matters is that no write moves money state.
    expect(updates.some((u) => u.payment_status === 'paid')).toBe(false)
    expect(updates.some((u) => u.status === 'cancelled' || u.status === 'completed')).toBe(false)
    const skip = inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)
    expect((skip!.metadata as Row).isE04111).toBe(true)
  })
})
