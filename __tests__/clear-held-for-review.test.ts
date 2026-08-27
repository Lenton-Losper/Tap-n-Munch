/**
 * "Clear all" on the Held for review surface — what happens TO EACH ORDER.
 *
 * WHY EVERY ASSERTION HERE READS THE STORED FIXTURE AND NOT THE RESULT OBJECT.
 *
 * A result object is what the code SAYS it did. The fixture rows are what it DID. Those two come
 * apart in exactly the cases that matter on a money path — a write that lands on the wrong row, a
 * skip that quietly writes anyway, an early return that reports zero while its id list is full —
 * and this repo has shipped all three. One agent's truncation test passed against 32KB of NUL bytes
 * because it asserted a length and not a content. So: the double STORES, `.eq()` is applied to
 * writes as well as reads, and the assertions are of the form "order X's payment_status is now Y
 * and order Z's is unchanged".
 *
 * THE TEST THIS SUITE EXISTS FOR IS `the positive control is what separates ...`. Two runs, the
 * same six orders, the same "not paid" answer for every one of them. In the first the control comes
 * back PAID and six orders are cancelled; in the second the control comes back not-paid and NOTHING
 * is written. Without the control those two runs are the same observation, which is the failure the
 * owner named: this codebase has already shipped a security chain that went green during a total
 * customer lockout for precisely that reason.
 */
import {
  CLEAR_HELD_OUTCOMES,
  CLEAR_HELD_OUTCOME_AUDIT_REASON,
  HELD_CLEAR_CONTROL_ACTION,
  HELD_CLEAR_SKIPPED_ACTION,
  MAX_CLEARED_PER_RUN,
  clearHeldBanner,
  clearHeldForReview,
  type ClearHeldOutcome,
} from '@/lib/orders/clear-held-for-review'
import {
  CLEAR_HELD_OUTCOME_COPY,
  CLEAR_HELD_PENDING_COPY_MARKER,
  CLEAR_HELD_UNSIGNED_OUTCOMES,
  unsignedClearHeldStrings,
} from '@/lib/orders/clear-held-for-review-copy'
import {
  E04111_MIN_OBSERVATION_SEPARATION_MS,
  E04111_PERSISTENCE_CANCEL_MS,
} from '@/lib/payments/query-finatic-order-paid'
import { ORDER_CANCELLED_ACTION } from '@/lib/orders/cancel-order-with-trail'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import type { FinaticOrderPaidResult } from '@/lib/payments/query-finatic-order-paid'

/**
 * The receipt issuer reaches the database and a PDF renderer, neither of which this suite is about.
 * It is called only on the mark-paid path and its failure is already swallowed there.
 */
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: jest.fn(async () => ({ issued: false })),
}))

/**
 * A FACTORY MOCK, which replaces the WHOLE module — so `isMissingFinaticCredentialsError` would read
 * as `undefined` if it were exported from here. It is not: it lives in
 * lib/payments/finatic-credentials-error, which nothing mocks, and that is the entire reason that
 * file exists. This suite is one of the eighteen the split was made for.
 */
const getRestaurantFinaticCredentials = jest.fn()
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: (...args: unknown[]) =>
    getRestaurantFinaticCredentials(...args),
}))

const RESTAURANT = 'rest-mingle'
const OTHER_RESTAURANT = 'rest-somewhere-else'
const LONG_AGO = '2026-08-14T09:00:00.000Z'
const NOW = new Date('2026-08-27T12:00:00.000Z').getTime()

const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

type Row = Record<string, unknown>

type OrderFixture = {
  id: string
  restaurant_id: string
  order_number: number | null
  total: number
  status: string
  payment_status: string
  channel: string | null
  placed_at: string | null
  table_number: number | null
  paycloud_merchant_order_no: string | null
  payment_reference: string | null
  payment_voucher_no: string | null
  paid_at: string | null
  payment_attempt_started_at: string | null
  tab_id?: string | null
  cancelled_at?: string | null
  cancellation_reason?: string | null
}

function order(partial: Partial<OrderFixture> & { id: string }): OrderFixture {
  return {
    restaurant_id: RESTAURANT,
    order_number: null,
    total: 52.5,
    status: 'completed',
    payment_status: 'pending',
    channel: 'pos',
    placed_at: LONG_AGO,
    table_number: 0,
    paycloud_merchant_order_no: `FT-${partial.id}`,
    payment_reference: null,
    payment_voucher_no: null,
    paid_at: null,
    /**
     * THE DEFAULT SATISFIES THE E04111 PERSISTENCE RULING, and it has to be said out loud because
     * it is load-bearing for every test in this file that is NOT about the ruling.
     *
     * The six live rows this fixture models were 13 days past their payment attempt when the owner
     * pressed the button. Every existing test here — the control, the markers, the concurrency
     * guards — asks a question that only arises AFTER the age gate has been passed, so the default
     * fixture passes it, exactly as the real six do. The tests that are about the gate itself
     * override this field and the observation history together, in
     * `the E04111 persistence ruling`.
     */
    payment_attempt_started_at: LONG_AGO,
    tab_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    ...partial,
  }
}

/**
 * The recorded E04111 observations for one reference, as `audit_logs` rows.
 *
 * SHAPED LIKE THE REAL WRITERS. `autoCancelStalePosOrders` writes `payment.verification_skipped`
 * and `handleTerminalPaymentFailed` writes `payment.verification_uncertain`; both carry
 * `metadata.businessOrderNo` and `metadata.isE04111`, which is the pair the action queries on. The
 * ACTION deliberately does not filter by `action`, so these rows use both names to prove that.
 */
function observation(
  merchantOrderNo: string,
  atMs: number,
  overrides: Row = {},
): Row {
  return {
    restaurant_id: RESTAURANT,
    entity_type: 'order',
    action: 'payment.verification_skipped',
    created_at: iso(atMs),
    metadata: { businessOrderNo: merchantOrderNo, isE04111: true, ...overrides },
  }
}

/**
 * The default history: two observations 13 days apart, ending yesterday — the shape the six live
 * cases have (103 to 106 rows each spanning 14 days, measured 2026-08-27), reduced to the two the
 * ruling actually requires.
 */
function defaultObservations(orders: OrderFixture[]): Row[] {
  const rows: Row[] = []
  for (const o of orders) {
    const ref = o.paycloud_merchant_order_no
    if (!ref) continue
    rows.push(observation(ref, NOW - 13 * 24 * HOUR))
    rows.push(observation(ref, NOW - 24 * HOUR, { isE04111: true }))
  }
  return rows
}

/** The six live rows the owner is going to press this button on: Mingle, N$315 total. */
function theSix(): OrderFixture[] {
  return [435, 462, 494, 523, 548, 615].map((n) =>
    order({ id: `o-${n}`, order_number: n, total: 52.5 }),
  )
}

type UpdateCall = { table: string; patch: Row; filters: Array<[string, unknown]> }

/**
 * A storing PostgREST double. `.eq()` / `.in()` / `.lt()` / `.not()` narrow reads AND writes, which
 * is what makes "this order's payment_status is now X" a statement about what the code wrote rather
 * than about what the double felt like returning.
 *
 * Every UPDATE is also recorded with its filters, so a test can assert that the concurrency guard
 * `.eq('payment_status','pending')` was actually in the statement. A guard that is present in the
 * source and absent from the call is invisible to every assertion about outcomes.
 */
/**
 * `metadata->>businessOrderNo` -> the value on a fixture row.
 *
 * The action filters the observation read with PostgREST's JSON-path equality, and a double that
 * ignored the path would return EVERY observation for EVERY reference — which is the difference
 * between "this reference has persisted" and "some reference somewhere has". That is the exact
 * class of false green this suite exists to refuse, so the double resolves the path for real.
 */
function jsonPathValue(row: Row, column: string): unknown {
  const arrow = column.indexOf('->>')
  if (arrow === -1) return row[column]
  const base = column.slice(0, arrow)
  const key = column.slice(arrow + 3).replace(/^['"]|['"]$/g, '')
  const container = row[base]
  if (!container || typeof container !== 'object') return undefined
  return (container as Row)[key]
}

function makeSupabase(orders: OrderFixture[], observations?: Row[]) {
  const audits: Row[] = []
  const updates: UpdateCall[] = []
  const observationRows = observations ?? defaultObservations(orders)

  const client = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      const ins: Array<[string, unknown[]]> = []
      const lts: Array<[string, unknown]> = []
      const notNulls: string[] = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      /**
       * THE COLUMN LIST FROM `.select(...)`, HONOURED.
       *
       * A double that hands back the whole fixture row whatever was selected is blind to the one
       * defect that cannot be seen any other way: a column the code READS off the row but never
       * ASKS the database for. #306 shipped exactly that — the route wrote `customer_edited_at` and
       * never selected it — and tsc, the unit tests and the reviewer were all blind, because in
       * TypeScript the field is declared and in a permissive double it is present.
       *
       * Here it would be worse than inert. `payment_attempt_started_at` missing from ORDER_COLUMNS
       * makes every E04111 read `undefined`, every verdict refuse with `no_attempt_timestamp`, and
       * the button quietly stop clearing anything — a failure that is SAFE, and therefore silent.
       * Projecting the row to what was actually selected is what makes that a red test.
       */
      let selected: string[] | null = null
      let limitN: number | null = null
      let orderBy: { col: string; ascending: boolean } | null = null
      const chain: Record<string, unknown> = {}
      const self = () => chain

      const matching = () => {
        let rows = orders.filter((row) => {
          const r = row as unknown as Row
          if (!eqs.every(([col, val]) => String(r[col] ?? '') === String(val))) return false
          if (!ins.every(([col, vals]) => vals.map(String).includes(String(r[col] ?? '')))) return false
          if (!lts.every(([col, val]) => String(r[col] ?? '') < String(val))) return false
          if (!notNulls.every((col) => r[col] !== null && r[col] !== undefined)) return false
          return true
        })
        if (orderBy) {
          const { col, ascending } = orderBy
          rows = [...rows].sort((a, b) => {
            const av = String((a as unknown as Row)[col] ?? '')
            const bv = String((b as unknown as Row)[col] ?? '')
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
          })
        }
        if (limitN !== null) rows = rows.slice(0, limitN)
        return rows
      }

      const resolve = () => {
        if (table === 'audit_logs') {
          if (op === 'update') return { data: [], error: null }
          let rows = observationRows.filter((r) =>
            eqs.every(([col, val]) => String(jsonPathValue(r, col) ?? '') === String(val)),
          )
          if (orderBy) {
            const { col, ascending } = orderBy
            rows = [...rows].sort((a, b) => {
              const av = String(jsonPathValue(a, col) ?? '')
              const bv = String(jsonPathValue(b, col) ?? '')
              return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
            })
          }
          if (limitN !== null) rows = rows.slice(0, limitN)
          return { data: rows.map((r) => ({ ...r })), error: null }
        }
        if (table === 'tabs') return { data: [], error: null }
        if (op === 'update') {
          const hit = matching()
          updates.push({ table, patch: { ...patch }, filters: [...eqs] })
          for (const row of hit) Object.assign(row, patch)
          return { data: hit.map((row) => ({ ...row })), error: null }
        }
        return { data: matching().map((row) => project(row as unknown as Row)), error: null }
      }

      /** A read returns the SELECTED columns and no others. See `selected` above for why. */
      const project = (row: Row): Row => {
        if (!selected) return { ...row }
        const out: Row = {}
        for (const col of selected) out[col] = row[col]
        return out
      }

      chain.select = (cols?: string) => {
        if (typeof cols === 'string' && cols.trim() !== '' && cols.trim() !== '*') {
          selected = cols.split(',').map((c) => c.trim()).filter(Boolean)
        }
        return self()
      }
      chain.insert = (row: Row) => {
        if (table === 'audit_logs') audits.push(row)
        return Promise.resolve({ data: null, error: null })
      }
      chain.update = (p: Row) => {
        op = 'update'
        patch = p
        return self()
      }
      chain.eq = (col: string, val: unknown) => {
        eqs.push([col, val])
        return self()
      }
      chain.in = (col: string, vals: unknown[]) => {
        ins.push([col, vals])
        return self()
      }
      chain.lt = (col: string, val: unknown) => {
        lts.push([col, val])
        return self()
      }
      chain.not = (col: string, operator: string, val: unknown) => {
        if (operator === 'is' && val === null) notNulls.push(col)
        return self()
      }
      chain.is = () => self()
      chain.order = (col: string, opts?: { ascending?: boolean }) => {
        orderBy = { col, ascending: opts?.ascending !== false }
        return self()
      }
      chain.limit = (n: number) => {
        limitN = n
        return self()
      }
      chain.range = (from: number) =>
        Promise.resolve(from === 0 ? resolve() : { data: [], error: null })
      chain.maybeSingle = () => {
        const { data, error } = resolve() as { data: Row[]; error: unknown }
        return Promise.resolve({ data: data[0] ?? null, error })
      }
      chain.single = () => (chain.maybeSingle as () => unknown)()
      chain.then = (onResolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onResolve)
      return chain
    },
  }

  return { client: client as never, audits, updates, orders }
}

function finatic(overrides: Partial<FinaticOrderPaidResult> = {}): FinaticOrderPaidResult {
  return {
    paid: false,
    statusRecognised: true,
    merchantOrderNo: 'FT',
    status: 'failed',
    transactionId: null,
    amount: null,
    raw: {},
    ...overrides,
  }
}

/** The E04111 shape `isFinaticMerchantOrderInvalidError` recognises: a thrown business error. */
function e04111Error() {
  const err = new Error('Merchant order number is invalid') as Error & { responseBody: Row }
  err.responseBody = { code: 'E04111', msg: 'Merchant order number is invalid' }
  return err
}

const CONTROL = order({
  id: 'o-678',
  order_number: 678,
  total: 40,
  payment_status: 'paid',
  status: 'completed',
  paid_at: '2026-08-27T11:00:00.000Z',
  paycloud_merchant_order_no: 'FT-CONTROL',
  // The HARD case, on purpose: paid while carrying neither marker, which is exactly the shape a
  // never-reached-the-gateway order has locally. Three such orders exist at FNB ChowNow.
  payment_reference: null,
  payment_voucher_no: null,
})

function outcomesById(summary: { outcomes: Array<{ orderId: string; outcome: string }> }) {
  return Object.fromEntries(summary.outcomes.map((o) => [o.orderId, o.outcome]))
}

function auditsFor(audits: Row[], action: string, entityId?: string) {
  return audits.filter(
    (a) => a.action === action && (entityId === undefined || a.entity_id === entityId),
  )
}

beforeEach(() => {
  getRestaurantFinaticCredentials.mockReset()
  getRestaurantFinaticCredentials.mockResolvedValue({
    merchantNo: 'M1',
    storeNo: 'S1',
    terminalSn: null,
    checkoutMerchantNo: 'M1',
    checkoutStoreNo: 'S1',
  })
})

describe('the positive control', () => {
  /**
   * THE ONE THAT MATTERS. Same six orders, same gateway verdict for every one of them, and the ONLY
   * difference between the two runs is what the control answered.
   */
  it('is what separates "all six are unpaid" from "the gateway is lying to us"', async () => {
    // --- run A: the control comes back PAID, so the not-paid answers are trustworthy -----------
    const a = makeSupabase([...theSix(), CONTROL])
    const summaryA = await clearHeldForReview(a.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        merchantOrderNo === 'FT-CONTROL'
          ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
          : finatic({ paid: false, statusRecognised: true, status: 'failed', merchantOrderNo }),
    })

    expect(summaryA.venues[0].control.verdict).toBe('passed')
    expect(summaryA.cancelledIds).toHaveLength(6)
    for (const row of a.orders.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('cancelled')
      expect(row.status).toBe('cancelled')
      expect(String(row.cancellation_reason)).toContain('positive control')
    }
    // The control itself was never written to. It is evidence, not a candidate.
    expect(a.orders.find((o) => o.id === CONTROL.id)!.payment_status).toBe('paid')

    // --- run B: identical answers for the six, but the CONTROL also answers not-paid ----------
    const b = makeSupabase([...theSix(), CONTROL])
    const summaryB = await clearHeldForReview(b.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      // A query path that has silently broken answers "not paid" for EVERYTHING, control included.
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        finatic({ paid: false, statusRecognised: true, status: 'failed', merchantOrderNo }),
    })

    expect(summaryB.venues[0].control.verdict).toBe('failed_not_paid')
    expect(summaryB.cancelledIds).toEqual([])
    // NOT ONE ROW MOVED. This is the assertion the whole guard exists for.
    for (const row of b.orders.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('pending')
      expect(row.status).toBe('completed')
      expect(row.cancelled_at).toBeNull()
    }
    for (const outcome of summaryB.outcomes) {
      expect(outcome.outcome).toBe('skipped_control_failed')
      expect(outcome.wrote).toBe(false)
    }
    // Every one of them is NAMED, in the database, not only in the response.
    for (const id of ['o-435', 'o-462', 'o-494', 'o-523', 'o-548', 'o-615']) {
      expect(auditsFor(b.audits, HELD_CLEAR_SKIPPED_ACTION, id)).toHaveLength(1)
    }
  })

  it('aborts the venue the moment it fails and leaves the remaining orders untouched and named', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    let controlAsks = 0
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        if (merchantOrderNo === 'FT-CONTROL') {
          controlAsks += 1
          // Healthy for the first two candidates, then the gateway goes down mid-run.
          if (controlAsks > 2) throw new Error('socket hang up')
          return finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
        }
        throw e04111Error()
      },
    })

    expect(summary.cancelledIds).toHaveLength(2)
    expect(summary.counts.skipped_control_failed).toBe(4)
    // Re-asked per candidate, which is the only reason the outage was caught at order three rather
    // than being vouched for by a control that passed before the first one.
    expect(summary.venues[0].control.asks).toBe(3)
    const byId = outcomesById(summary)
    const cancelled = s.orders.filter((o) => o.payment_status === 'cancelled')
    expect(cancelled).toHaveLength(2)
    for (const row of s.orders.filter((o) => o.id !== CONTROL.id)) {
      if (byId[row.id] === 'cancelled') expect(row.payment_status).toBe('cancelled')
      else expect(row.payment_status).toBe('pending')
    }
  })

  it('records itself in the database even when the run wrote nothing else', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const control = auditsFor(s.audits, HELD_CLEAR_CONTROL_ACTION)
    expect(control).toHaveLength(1)
    const metadata = control[0].metadata as Row
    expect(metadata.verdict).toBe('failed_gateway_error')
    expect(metadata.controlOrderId).toBe('o-678')
    expect(metadata.controlMarkerless).toBe(true)
    expect(Number(metadata.gatewayAsksFailed)).toBeGreaterThan(0)
  })

  it('reports a run in which every gateway call failed as exactly that, and never as "all unpaid"', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async () => {
        throw new Error('fetch failed')
      },
    })
    expect(summary.gatewayAsks).toBeGreaterThan(0)
    expect(summary.gatewayAsksFailed).toBe(summary.gatewayAsks)
    expect(summary.allGatewayCallsFailed).toBe(true)
    expect(clearHeldBanner(summary)).toBe('all_gateway_calls_failed')
    // and the same run, with a working gateway and genuinely unpaid orders, must NOT say that
    const ok = makeSupabase([...theSix(), CONTROL])
    const good = await clearHeldForReview(ok.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        merchantOrderNo === 'FT-CONTROL'
          ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
          : finatic({ paid: false, status: 'failed', merchantOrderNo }),
    })
    expect(good.allGatewayCallsFailed).toBe(false)
    expect(clearHeldBanner(good)).toBeNull()
  })

  it('refuses to act at a venue with no known-paid order to test against', async () => {
    const s = makeSupabase(theSix())
    const asks: string[] = []
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        asks.push(merchantOrderNo)
        return finatic({ paid: false, merchantOrderNo })
      },
    })
    expect(asks).toEqual([])
    expect(summary.counts.skipped_control_unavailable).toBe(6)
    expect(clearHeldBanner(summary)).toBe('control_unavailable')
    for (const row of s.orders) expect(row.payment_status).toBe('pending')
  })
})

describe('what happens to each order', () => {
  const controlPasses = (fn: (merchantOrderNo: string) => Promise<FinaticOrderPaidResult>) =>
    async ({ merchantOrderNo }: { merchantOrderNo: string }) =>
      merchantOrderNo === 'FT-CONTROL'
        ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
        : fn(merchantOrderNo)

  it('cancels only the unpaid ones and marks the paid one PAID rather than cancelling it', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async (merchantOrderNo) => {
        if (merchantOrderNo === 'FT-o-494') {
          return finatic({
            paid: true,
            status: 'paid',
            amount: 52.5,
            transactionId: 'TXN-494',
            merchantOrderNo,
          })
        }
        return finatic({ paid: false, statusRecognised: true, status: 'failed', merchantOrderNo })
      }),
    })

    expect(summary.paidIds).toEqual(['o-494'])
    expect(summary.cancelledIds.sort()).toEqual(
      ['o-435', 'o-462', 'o-523', 'o-548', 'o-615'].sort(),
    )

    const paid = s.orders.find((o) => o.id === 'o-494')!
    expect(paid.payment_status).toBe('paid')
    expect(paid.status).toBe('completed')
    expect(paid.paid_at).toBeTruthy()
    expect(paid.cancelled_at).toBeNull()
    expect(paid.payment_voucher_no).toBe('TXN-494')

    // and the trail says the gateway's figure is the gateway's, not the order's
    const completed = s.audits.filter((a) => a.action === 'payment.completed')
    expect(completed).toHaveLength(1)
    const metadata = completed[0].metadata as Row
    expect(metadata.amountMeaning).toBe('gateway_reported')
    expect(metadata.gatewayAmount).toBe(52.5)
    expect((metadata.positiveControl as Row).verdict).toBe('passed')
  })

  it('quarantines a confirmed payment whose amount does not agree, neither paying nor cancelling', async () => {
    const s = makeSupabase([order({ id: 'o-1', order_number: 1, total: 200 }), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async (merchantOrderNo) =>
        finatic({ paid: true, status: 'paid', amount: 20, merchantOrderNo }),
      ),
    })
    expect(outcomesById(summary)['o-1']).toBe('gateway_paid_amount_disagrees')
    const row = s.orders.find((o) => o.id === 'o-1')!
    expect(row.payment_status).toBe('amount_mismatch_hold')
    expect(row.paid_at).toBeNull()
    expect(row.cancelled_at).toBeNull()
    const held = s.audits.filter((a) => a.action === 'payment_amount_mismatch_held')
    expect(held).toHaveLength(1)
    expect((held[0].metadata as Row).source).toBe('held_for_review_clear_all')
    expect((held[0].metadata as Row).gatewayAmount).toBe(20)
    expect((held[0].metadata as Row).orderTotal).toBe(200)
  })

  it('quarantines a confirmed payment that carried NO amount — absent is not agreeing', async () => {
    const s = makeSupabase([order({ id: 'o-1', order_number: 1, total: 200 }), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async (merchantOrderNo) =>
        finatic({ paid: true, status: 'paid', amount: null, merchantOrderNo }),
      ),
    })
    expect(outcomesById(summary)['o-1']).toBe('gateway_paid_amount_disagrees')
    expect(s.orders.find((o) => o.id === 'o-1')!.payment_status).toBe('amount_mismatch_hold')
  })

  it('never cancels on a status it does not recognise', async () => {
    const s = makeSupabase([order({ id: 'o-1', order_number: 1 }), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async (merchantOrderNo) =>
        finatic({ paid: false, statusRecognised: false, status: '7', merchantOrderNo }),
      ),
    })
    expect(outcomesById(summary)['o-1']).toBe('skipped_gateway_status_unrecognised')
    expect(s.orders.find((o) => o.id === 'o-1')!.payment_status).toBe('pending')
    // the unknown value is recorded verbatim, so it is findable here and not in a cancelled order
    const skip = auditsFor(s.audits, HELD_CLEAR_SKIPPED_ACTION, 'o-1')[0]
    expect((skip.metadata as Row).gatewayStatus).toBe('7')
    expect((skip.metadata as Row).gatewayCode).toBe('7')
  })

  it('cancels on E04111 only when no payment marker exists, and names the contradiction when one does', async () => {
    const s = makeSupabase([
      order({ id: 'o-clean', order_number: 1 }),
      order({ id: 'o-marked', order_number: 2, payment_reference: 'REF-XYZ' }),
      CONTROL,
    ])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async () => {
        throw e04111Error()
      }),
    })
    const byId = outcomesById(summary)
    expect(byId['o-clean']).toBe('cancelled')
    expect(byId['o-marked']).toBe('skipped_gateway_no_record_but_marker_present')
    expect(s.orders.find((o) => o.id === 'o-clean')!.payment_status).toBe('cancelled')
    expect(s.orders.find((o) => o.id === 'o-marked')!.payment_status).toBe('pending')

    const cancelAudit = auditsFor(s.audits, ORDER_CANCELLED_ACTION, 'o-clean')[0]
    const metadata = cancelAudit.metadata as Row
    expect(metadata.basis).toBe('e04111_no_attempt_reached_gateway')
    expect(metadata.gatewayCode).toBe('E04111')
    expect(metadata.source).toBe('held_for_review_clear_all')
    expect((metadata.positiveControl as Row).verdict).toBe('passed')
  })

  it('leaves an order with no gateway reference alone rather than importing the POS cron rule', async () => {
    const s = makeSupabase([
      order({
        id: 'o-till',
        order_number: 9,
        channel: 'table',
        status: 'ready',
        paycloud_merchant_order_no: null,
      }),
      CONTROL,
    ])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async () => {
        throw new Error('should never be asked')
      }),
    })
    expect(outcomesById(summary)['o-till']).toBe('unverifiable_no_gateway_reference')
    const row = s.orders.find((o) => o.id === 'o-till')!
    expect(row.payment_status).toBe('pending')
    expect(row.status).toBe('ready')
  })

  it('keeps the successes when one order\'s gateway call fails', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async (merchantOrderNo) => {
        if (merchantOrderNo === 'FT-o-523') throw new Error('ETIMEDOUT')
        throw e04111Error()
      }),
    })
    expect(summary.cancelledIds).toHaveLength(5)
    expect(outcomesById(summary)['o-523']).toBe('skipped_gateway_unreachable')
    expect(s.orders.find((o) => o.id === 'o-523')!.payment_status).toBe('pending')
    expect(
      s.orders.filter((o) => o.id !== CONTROL.id && o.id !== 'o-523').every(
        (o) => o.payment_status === 'cancelled',
      ),
    ).toBe(true)
    // Five correct answers survived the sixth's timeout. No transaction discarded them.
    expect(auditsFor(s.audits, ORDER_CANCELLED_ACTION)).toHaveLength(5)
  })

  it('gives every order it looked at exactly one outcome, and one audit row', async () => {
    const s = makeSupabase([...theSix(), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses(async () => {
        throw e04111Error()
      }),
    })
    expect(summary.outcomes).toHaveLength(6)
    expect(new Set(summary.outcomes.map((o) => o.orderId)).size).toBe(6)
    for (const outcome of summary.outcomes) {
      expect(CLEAR_HELD_OUTCOMES).toContain(outcome.outcome)
      // THE FRESH GATEWAY CODE, ON EACH ORDER. Never null, never inherited.
      expect(typeof outcome.gatewayCode).toBe('string')
      expect(outcome.gatewayCode.length).toBeGreaterThan(0)
      expect(outcome.gatewayAskedAt).toBeTruthy()
    }
    expect(auditsFor(s.audits, ORDER_CANCELLED_ACTION)).toHaveLength(6)
    expect(auditsFor(s.audits, HELD_CLEAR_CONTROL_ACTION)).toHaveLength(1)
  })
})

describe('venues with no Finatic credentials', () => {
  it('reports every order unverifiable, writes nothing, and never cancels', async () => {
    getRestaurantFinaticCredentials.mockRejectedValue(new MissingFinaticCredentialsError(RESTAURANT))
    const s = makeSupabase([...theSix(), CONTROL])
    const asks: string[] = []
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        asks.push(merchantOrderNo)
        return finatic({ merchantOrderNo })
      },
    })
    // Not one call went out: there is nothing to form a question with.
    expect(asks).toEqual([])
    expect(summary.counts.unverifiable_no_credentials).toBe(6)
    expect(summary.cancelledIds).toEqual([])
    expect(summary.venues[0].control.verdict).toBe('unavailable_no_credentials')
    expect(clearHeldBanner(summary)).toBe('no_credentials')
    for (const row of s.orders.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('pending')
      expect(row.cancelled_at).toBeNull()
    }
    for (const id of ['o-435', 'o-462', 'o-494', 'o-523', 'o-548', 'o-615']) {
      const named = auditsFor(s.audits, HELD_CLEAR_SKIPPED_ACTION, id)
      expect(named).toHaveLength(1)
      expect((named[0].metadata as Row).outcome).toBe('unverifiable_no_credentials')
      expect((named[0].metadata as Row).gatewayCode).toBe('NO_CREDENTIALS')
    }
  })

  it('treats a credential read that FAILED as unknown, not as absent', async () => {
    getRestaurantFinaticCredentials.mockRejectedValue(new Error('cache read failed'))
    const s = makeSupabase([...theSix(), CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => finatic({ merchantOrderNo }),
    })
    // Unknown must not take the permanent name, and must not authorise anything either.
    expect(summary.counts.unverifiable_no_credentials).toBe(0)
    expect(summary.counts.skipped_gateway_unreachable).toBe(6)
    expect(summary.cancelledIds).toEqual([])
    for (const row of s.orders.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('pending')
    }
  })
})

describe('concurrency and idempotence', () => {
  it('re-reads each order immediately before the write and skips one that settled meanwhile', async () => {
    const fixtures = [...theSix(), CONTROL]
    const s = makeSupabase(fixtures)
    let controlAsks = 0
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        if (merchantOrderNo === 'FT-CONTROL') {
          controlAsks += 1
          /**
           * A LIVE TERMINAL CALLBACK LANDS MID-RUN, on the order that is NEXT in line, after the
           * enumeration listed it as pending and before this run re-reads it. The enumeration is
           * already stale by then; only the re-read immediately before the write can see it.
           *
           * The control is asked first in each iteration, so asking for the second time is exactly
           * the moment just before o-462 is re-read.
           */
          if (controlAsks === 2) {
            const victim = fixtures.find((o) => o.id === 'o-462')!
            victim.payment_status = 'paid'
            victim.status = 'completed'
            victim.paid_at = '2026-08-27T11:59:59.000Z'
          }
          return finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
        }
        throw e04111Error()
      },
    })
    const byId = outcomesById(summary)
    expect(byId['o-462']).toBe('skipped_already_resolved')
    const settled = fixtures.find((o) => o.id === 'o-462')!
    // The payment SURVIVED. It was not overwritten by a cancel.
    expect(settled.payment_status).toBe('paid')
    expect(settled.cancelled_at).toBeNull()
    expect(summary.cancelledIds).not.toContain('o-462')

    /**
     * THE ASSERTION THAT ACTUALLY PINS THE RE-READ, and it was added because the obvious one did
     * not. Deleting the re-read gate entirely left every assertion above still green: the write
     * itself re-asserts `payment_status='pending'`, so the cancel matched zero rows and the outcome
     * came out `skipped_already_resolved` by a different route. Two guards, one visible symptom.
     *
     * `gatewayAskedAt === null` is the half only the re-read can produce. It says the order was
     * dropped BEFORE Finatic was asked about it, which is what "re-read immediately before the
     * write" means, as opposed to "asked, then refused by the database".
     */
    const settledOutcome = summary.outcomes.find((o) => o.orderId === 'o-462')!
    expect(settledOutcome.gatewayAskedAt).toBeNull()
    expect(settledOutcome.gatewayCode).toBe('NOT_ASKED')
  })

  it('re-reads the payment MARKERS too, so one that appears mid-run stops the E04111 cancel', async () => {
    /**
     * The markers are the other half of the E04111 conjunction, and they are read from the FRESH
     * row for the same reason the status is: a terminal that reaches the gateway between the
     * enumeration and the write writes `payment_reference`, and an order that has now reached the
     * gateway must not be cancelled on the reasoning that it never did.
     */
    const fixtures = [...theSix(), CONTROL]
    const s = makeSupabase(fixtures)
    let controlAsks = 0
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        if (merchantOrderNo === 'FT-CONTROL') {
          controlAsks += 1
          if (controlAsks === 3) {
            fixtures.find((o) => o.id === 'o-494')!.payment_reference = 'REF-LATE'
          }
          return finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
        }
        throw e04111Error()
      },
    })
    expect(outcomesById(summary)['o-494']).toBe('skipped_gateway_no_record_but_marker_present')
    expect(fixtures.find((o) => o.id === 'o-494')!.payment_status).toBe('pending')
    expect(summary.cancelledIds).not.toContain('o-494')
    expect(summary.cancelledIds).toHaveLength(5)
  })

  it('carries the pending re-assertion in the cancel UPDATE itself, so a second writer matches nothing', async () => {
    const s = makeSupabase([order({ id: 'o-1', order_number: 1 }), CONTROL])
    await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        merchantOrderNo === 'FT-CONTROL'
          ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
          : finatic({ paid: false, status: 'failed', merchantOrderNo }),
    })
    const cancelUpdate = s.updates.find(
      (u) => u.table === 'orders' && u.patch.payment_status === 'cancelled',
    )
    expect(cancelUpdate).toBeDefined()
    // The guard is IN THE STATEMENT. Present in the source and absent from the call is invisible
    // to every assertion about outcomes.
    expect(cancelUpdate!.filters).toContainEqual(['payment_status', 'pending'])
    expect(cancelUpdate!.filters).toContainEqual(['restaurant_id', RESTAURANT])
  })

  it('a second press finds nothing left to do and writes nothing twice', async () => {
    const fixtures = [...theSix(), CONTROL]
    const s = makeSupabase(fixtures)
    const queryFn = async ({ merchantOrderNo }: { merchantOrderNo: string }) =>
      merchantOrderNo === 'FT-CONTROL'
        ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
        : finatic({ paid: false, status: 'failed', merchantOrderNo })

    const first = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: queryFn,
    })
    const second = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: queryFn,
    })

    expect(first.cancelledIds).toHaveLength(6)
    expect(second.cancelledIds).toEqual([])
    expect(second.outcomes).toEqual([])
    // SIX cancels across two presses, not twelve.
    expect(auditsFor(s.audits, ORDER_CANCELLED_ACTION)).toHaveLength(6)
    for (const row of fixtures.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('cancelled')
    }
  })
})

describe('scope', () => {
  it('never touches another restaurant\'s held orders', async () => {
    const foreign = order({
      id: 'o-foreign',
      order_number: 99,
      restaurant_id: OTHER_RESTAURANT,
    })
    const s = makeSupabase([...theSix(), CONTROL, foreign])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        merchantOrderNo === 'FT-CONTROL'
          ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
          : finatic({ paid: false, status: 'failed', merchantOrderNo }),
    })
    expect(summary.outcomes.map((o) => o.orderId)).not.toContain('o-foreign')
    expect(s.orders.find((o) => o.id === 'o-foreign')!.payment_status).toBe('pending')
  })

  it('names the two hold causes without asking the gateway about them', async () => {
    const s = makeSupabase([
      order({ id: 'o-mismatch', order_number: 1, payment_status: 'amount_mismatch_hold' }),
      order({ id: 'o-unverifiable', order_number: 2, payment_status: 'verification_unavailable_hold' }),
      CONTROL,
    ])
    const asks: string[] = []
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
        asks.push(merchantOrderNo)
        return finatic({ merchantOrderNo })
      },
    })
    const byId = outcomesById(summary)
    expect(byId['o-mismatch']).toBe('skipped_gateway_confirmed_payment_already_held')
    expect(byId['o-unverifiable']).toBe('unverifiable_no_credentials')
    expect(asks).toEqual([])
    expect(s.orders.find((o) => o.id === 'o-mismatch')!.payment_status).toBe('amount_mismatch_hold')
    expect(s.orders.find((o) => o.id === 'o-unverifiable')!.payment_status).toBe(
      'verification_unavailable_hold',
    )
  })

  it('defers past the per-run ceiling instead of doing everything at once', async () => {
    const many = Array.from({ length: MAX_CLEARED_PER_RUN + 3 }, (_, i) =>
      order({ id: `o-${i}`, order_number: i, total: 10 }),
    )
    const s = makeSupabase([...many, CONTROL])
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: async ({ merchantOrderNo }) =>
        merchantOrderNo === 'FT-CONTROL'
          ? finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
          : finatic({ paid: false, status: 'failed', merchantOrderNo }),
    })
    expect(summary.counts.cancelled).toBe(MAX_CLEARED_PER_RUN)
    expect(summary.counts.deferred_run_cap).toBe(3)
    expect(s.orders.filter((o) => o.payment_status === 'pending')).toHaveLength(3)
  })

  it('leaves a held cause it does not recognise alone rather than sweeping it into the cancel path', async () => {
    /**
     * The surface is built so a NEW member of HELD_FOR_REVIEW_PAYMENT_STATUSES starts rendering
     * without an edit. This action must fail the other way. Asserted by driving the classifier
     * directly, since a status this branch does not carry cannot be produced by a fixture.
     */
    const { heldForReviewCause } = jest.requireActual<
      typeof import('@/lib/orders/held-for-review')
    >('@/lib/orders/held-for-review')
    expect(heldForReviewCause({ id: 'x', payment_status: 'some_future_hold' }, NOW)).toBeNull()
  })
})

/**
 * ==================================================================================================
 * THE E04111 PERSISTENCE RULING — owner, 2026-08-27.
 * ==================================================================================================
 *
 * The ruling itself is implemented once, in `e04111PersistenceAuthorisesCancel`, and has eleven
 * two-sided tests of its own in __tests__/e04111-persistence-ruling.test.ts. NOTHING HERE RE-TESTS
 * THE ARITHMETIC. What is tested here is the thing those tests cannot see: that THIS ACTION calls
 * it, feeds it the right three inputs, and does what it says — including on the rows.
 *
 * A helper with perfect tests that no caller consults is a fix that shipped inert, and this repo has
 * done exactly that before (#306 wrote `customer_edited_at` and never selected it; tsc and the unit
 * tests were both blind). So every assertion below reads the stored fixture, not the summary.
 *
 * EVERY TEST IN THIS BLOCK IS TWO-SIDED OR PAIRED WITH ONE. "It did not cancel" is not a result on
 * its own — a run that cancels nothing because the gateway double is broken looks identical. The
 * first test runs the two cases through the SAME fixture with the SAME answers and the same control,
 * varying only the clock.
 */
describe('the E04111 persistence ruling', () => {
  const controlPasses = async ({ merchantOrderNo }: { merchantOrderNo: string }) => {
    if (merchantOrderNo === 'FT-CONTROL') {
      return finatic({ paid: true, status: 'paid', amount: 40, merchantOrderNo })
    }
    throw e04111Error()
  }

  /** Two observations, 13 days apart, ending yesterday — the six live cases' shape. */
  const persistentHistory = (ref: string) => [
    observation(ref, NOW - 14 * 24 * HOUR),
    observation(ref, NOW - 24 * HOUR),
  ]

  it('THE PAIR: a 20-hour-old E04111 is not cancelled, a 14-day-old one with two observations 14 days apart is', async () => {
    /**
     * THE ONLY DIFFERENCE BETWEEN THESE TWO RUNS IS `payment_attempt_started_at`. Same gateway
     * answer (E04111, thrown, every time), same passing control, same markerless order, same
     * observation history — thirteen days of it, so the observation conditions hold in BOTH runs
     * and the age is the sole variable.
     *
     * Order #149 is why: it answered E04111 at 13:58:48 and was confirmed PAID on the same
     * reference at 13:59:10. Cancelling the young one is cancelling a card that is still settling.
     */
    const young = order({
      id: 'o-young',
      order_number: 20,
      payment_attempt_started_at: iso(NOW - 20 * HOUR),
    })
    const a = makeSupabase([young, CONTROL], persistentHistory('FT-o-young'))
    const summaryA = await clearHeldForReview(a.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })

    expect(summaryA.venues[0].control.verdict).toBe('passed')
    expect(outcomesById(summaryA)['o-young']).toBe('skipped_e04111_too_recent')
    expect(summaryA.cancelledIds).toEqual([])
    // THE ROW. Not the summary.
    const youngRow = a.orders.find((o) => o.id === 'o-young')!
    expect(youngRow.payment_status).toBe('pending')
    expect(youngRow.status).toBe('completed')
    expect(youngRow.cancelled_at).toBeNull()
    expect(youngRow.cancellation_reason).toBeNull()

    // --- the other side, so "nothing was cancelled" is a decision and not a broken double -----
    const old = order({
      id: 'o-old',
      order_number: 21,
      payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR),
    })
    const b = makeSupabase([old, CONTROL], persistentHistory('FT-o-old'))
    const summaryB = await clearHeldForReview(b.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })

    expect(outcomesById(summaryB)['o-old']).toBe('cancelled')
    expect(summaryB.cancelledIds).toEqual(['o-old'])
    const oldRow = b.orders.find((o) => o.id === 'o-old')!
    expect(oldRow.payment_status).toBe('cancelled')
    expect(oldRow.status).toBe('cancelled')
    expect(oldRow.cancelled_at).not.toBeNull()
  })

  it('measures the age from payment_attempt_started_at and NEVER falls back to placed_at', async () => {
    /**
     * THE DISTINCTION THE RULING NAMES FIRST. An order placed a week ago whose card was presented
     * ten minutes ago is TEN MINUTES old for this purpose. `placed_at` stays at LONG_AGO — thirteen
     * days — in both fixtures, so a fallback to it would cancel both, and only the attempt clock
     * separates them.
     */
    const recentAttempt = order({
      id: 'o-old-order-new-card',
      order_number: 22,
      placed_at: LONG_AGO,
      payment_attempt_started_at: iso(NOW - 10 * 60 * 1000),
    })
    const s = makeSupabase([recentAttempt, CONTROL], persistentHistory('FT-o-old-order-new-card'))
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(summary)['o-old-order-new-card']).toBe('skipped_e04111_too_recent')
    expect(s.orders.find((o) => o.id === 'o-old-order-new-card')!.payment_status).toBe('pending')

    // A missing timestamp REFUSES rather than falling back — its own outcome, not `too_recent`.
    const noAttempt = order({
      id: 'o-no-attempt',
      order_number: 23,
      placed_at: LONG_AGO,
      payment_attempt_started_at: null,
    })
    const t = makeSupabase([noAttempt, CONTROL], persistentHistory('FT-o-no-attempt'))
    const summaryT = await clearHeldForReview(t.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(summaryT)['o-no-attempt']).toBe('skipped_e04111_no_attempt_timestamp')
    expect(t.orders.find((o) => o.id === 'o-no-attempt')!.payment_status).toBe('pending')
  })

  it('refuses on too few observations, and on two that are too close together, under their own names', async () => {
    const ancient = (id: string) =>
      order({ id, order_number: 24, payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR) })

    // --- none at all ---------------------------------------------------------------------
    const none = makeSupabase([ancient('o-none'), CONTROL], [])
    const sNone = await clearHeldForReview(none.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(sNone)['o-none']).toBe('skipped_e04111_insufficient_observations')
    expect(none.orders.find((o) => o.id === 'o-none')!.payment_status).toBe('pending')

    // --- exactly one ---------------------------------------------------------------------
    const one = makeSupabase(
      [ancient('o-one'), CONTROL],
      [observation('FT-o-one', NOW - 10 * 24 * HOUR)],
    )
    const sOne = await clearHeldForReview(one.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(sOne)['o-one']).toBe('skipped_e04111_insufficient_observations')
    expect(one.orders.find((o) => o.id === 'o-one')!.payment_status).toBe('pending')

    // --- two, six hours apart: one moment sampled twice ----------------------------------
    const close = makeSupabase(
      [ancient('o-close'), CONTROL],
      [
        observation('FT-o-close', NOW - 10 * 24 * HOUR),
        observation('FT-o-close', NOW - 10 * 24 * HOUR + 6 * HOUR),
      ],
    )
    const sClose = await clearHeldForReview(close.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(sClose)['o-close']).toBe('skipped_e04111_observations_too_close_together')
    expect(close.orders.find((o) => o.id === 'o-close')!.payment_status).toBe('pending')

    // --- and the positive control on all three: the SAME order with a 24h span DOES cancel
    const wide = makeSupabase(
      [ancient('o-wide'), CONTROL],
      [
        observation('FT-o-wide', NOW - 10 * 24 * HOUR),
        observation('FT-o-wide', NOW - 10 * 24 * HOUR + E04111_MIN_OBSERVATION_SEPARATION_MS),
      ],
    )
    const sWide = await clearHeldForReview(wide.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(sWide)['o-wide']).toBe('cancelled')
    expect(wide.orders.find((o) => o.id === 'o-wide')!.payment_status).toBe('cancelled')
  })

  it('counts observations for THIS reference only, and only the ones marked isE04111', async () => {
    /**
     * KEYED ON `metadata->>businessOrderNo`, NOT ON THE ORDER ID, and filtered on
     * `metadata->>isE04111`. Both halves matter and both are two-sided in one run:
     *
     *   o-mine  has two E04111 observations on ITS OWN reference       -> cancelled
     *   o-other has two on somebody else's reference, plus two of its  -> refused, and the outcome
     *           own that are NOT E04111                                   names the count as the reason
     *
     * A double that ignored the JSON path would give both orders the same history and both would
     * cancel. That is the false green this asserts against.
     */
    const mine = order({
      id: 'o-mine',
      order_number: 25,
      payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR),
    })
    const other = order({
      id: 'o-other',
      order_number: 26,
      payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR),
    })
    const s = makeSupabase(
      [mine, other, CONTROL],
      [
        ...persistentHistory('FT-o-mine'),
        // o-other's own rows, recorded for a DIFFERENT reason: the gateway was unreachable, not
        // E04111. Same order, same table, same age, and they must not count.
        observation('FT-o-other', NOW - 14 * 24 * HOUR, { isE04111: false }),
        observation('FT-o-other', NOW - 24 * HOUR, { isE04111: false }),
      ],
    )
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    const byId = outcomesById(summary)
    expect(byId['o-mine']).toBe('cancelled')
    expect(byId['o-other']).toBe('skipped_e04111_insufficient_observations')
    expect(s.orders.find((o) => o.id === 'o-mine')!.payment_status).toBe('cancelled')
    expect(s.orders.find((o) => o.id === 'o-other')!.payment_status).toBe('pending')
  })

  it('records the cancel as authorised BY THE PERSISTENCE RULE, with the numbers it was decided on', async () => {
    /**
     * THE AUDIT ROW IS THE DELIVERABLE HERE, not a side effect. Reconstructing this run later, a
     * reader must be able to tell an E04111 persistence cancel from a `paid=false` cancel WITHOUT
     * inferring it — they are different evidence, and `queryFinaticOrderPaid` never returns
     * `paid: false` for an E04111 at all: the call throws. Rule 20 applies to a row as much as to a
     * comment, so the age, the count and the span are recorded as measurements alongside the
     * thresholds they were compared against.
     */
    const o = order({
      id: 'o-audited',
      order_number: 27,
      payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR),
    })
    const s = makeSupabase([o, CONTROL], persistentHistory('FT-o-audited'))
    await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })

    const metadata = auditsFor(s.audits, ORDER_CANCELLED_ACTION, 'o-audited')[0].metadata as Row
    expect(metadata.basis).toBe('e04111_no_attempt_reached_gateway')
    expect(metadata.gatewayCode).toBe('E04111')
    // WHICH RULE FIRED, in the row, in words as well as in a token.
    expect(metadata.authorisedBy).toBe('e04111_persistence_rule')
    expect(String(metadata.authorisedByNote)).toContain('NOT on a paid=false answer')

    const p = metadata.e04111Persistence as Row
    expect(p.reason).toBe('persisted_beyond_threshold')
    expect(p.authorisesCancel).toBe(true)
    expect(p.attemptStartedAt).toBe(iso(NOW - 14 * 24 * HOUR))
    expect(p.ageMs).toBe(14 * 24 * HOUR)
    expect(p.ageHours).toBe(14 * 24)
    expect(p.observationCount).toBe(2)
    expect(p.observationSpanMs).toBe(13 * 24 * HOUR)
    expect(p.observationSpanHours).toBe(13 * 24)
    expect(p.reconfirmedNow).toBe(true)
    expect(typeof p.reconfirmedAt).toBe('string')
    // The thresholds it was compared against, so the row stays readable when they change.
    expect(p.thresholdMs).toBe(E04111_PERSISTENCE_CANCEL_MS)
    expect(p.minObservationSeparationMs).toBe(E04111_MIN_OBSERVATION_SEPARATION_MS)
  })

  it('records a refusal with its own numbers too, so a staff question can be answered from the row', async () => {
    const o = order({
      id: 'o-refused',
      order_number: 28,
      payment_attempt_started_at: iso(NOW - 20 * HOUR),
    })
    const s = makeSupabase([o, CONTROL], persistentHistory('FT-o-refused'))
    await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })

    // Not cancelled, and not silently: a skip row exists and it says why.
    expect(auditsFor(s.audits, ORDER_CANCELLED_ACTION, 'o-refused')).toHaveLength(0)
    const skip = auditsFor(s.audits, HELD_CLEAR_SKIPPED_ACTION, 'o-refused')[0]
    const metadata = skip.metadata as Row
    expect(metadata.outcome).toBe('skipped_e04111_too_recent')
    // The FRESH gateway code, never 'NOT_ASKED': the order WAS asked about, in this run.
    expect(metadata.gatewayCode).toBe('E04111')
    expect(metadata.gatewayAskedAt).toEqual(expect.any(String))
    const p = metadata.e04111Persistence as Row
    expect(p.reason).toBe('too_recent')
    expect(p.authorisesCancel).toBe(false)
    expect(p.ageHours).toBe(20)
    expect(p.observationCount).toBe(2)
    expect(String(metadata.reason)).toContain('72h')
  })

  it('leaves the READ failure refusing, never cancelling', async () => {
    /**
     * The observation read is not the money path and must not be able to abort a run — but the
     * direction it fails in is the whole question. An unrelated read failure that produced an empty
     * history and then CANCELLED would be the worst possible shape: a broken instrument authorising
     * a write. Empty history means the second condition cannot hold, so it refuses.
     *
     * Driven by handing the action a client whose audit_logs SELECT throws, which is what a
     * PostgREST error looks like from inside `readE04111Observations`.
     */
    const o = order({
      id: 'o-readfail',
      order_number: 29,
      payment_attempt_started_at: iso(NOW - 14 * 24 * HOUR),
    })
    const s = makeSupabase([o, CONTROL], persistentHistory('FT-o-readfail'))
    const inner = s.client as unknown as { from: (t: string) => Record<string, unknown> }
    const realFrom = inner.from.bind(inner)
    const broken = {
      from(table: string) {
        const chain = realFrom(table)
        if (table !== 'audit_logs') return chain
        // Only the SELECT path breaks. `.insert()` still records, so the skip is still audited.
        const select = chain.select as () => Record<string, unknown>
        chain.select = () => {
          const c = select()
          c.then = (_ok: unknown, fail: (e: unknown) => unknown) =>
            Promise.reject(new Error('audit_logs read exploded')).catch(fail as never)
          return c
        }
        return chain
      },
    }
    const summary = await clearHeldForReview(broken as never, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })
    expect(outcomesById(summary)['o-readfail']).toBe('skipped_e04111_insufficient_observations')
    expect(s.orders.find((o2) => o2.id === 'o-readfail')!.payment_status).toBe('pending')
    expect(summary.cancelledIds).toEqual([])
  })

  it('still refuses a young order even when everything else about the run is perfect', async () => {
    /**
     * THE PERMISSIVENESS TEST, stated as the whole run rather than as one branch. Six orders, all
     * markerless, all answering E04111, all with a passing markerless control and a full
     * observation history — the exact shape that WOULD have cancelled all six before the ruling —
     * differing only in that their cards were presented this morning.
     *
     * Not one row moves, and every one of them is named.
     */
    const six = theSix().map((o) => ({ ...o, payment_attempt_started_at: iso(NOW - 3 * HOUR) }))
    const history = six.flatMap((o) => persistentHistory(o.paycloud_merchant_order_no!))
    const s = makeSupabase([...six, CONTROL], history)
    const summary = await clearHeldForReview(s.client, {
      restaurantId: RESTAURANT,
      nowMs: NOW,
      queryFinaticOrderPaidFn: controlPasses,
    })

    expect(summary.venues[0].control.verdict).toBe('passed')
    expect(summary.cancelledIds).toEqual([])
    for (const row of s.orders.filter((o) => o.id !== CONTROL.id)) {
      expect(row.payment_status).toBe('pending')
      expect(row.status).toBe('completed')
      expect(row.cancelled_at).toBeNull()
    }
    for (const outcome of summary.outcomes) {
      expect(outcome.outcome).toBe('skipped_e04111_too_recent')
      expect(outcome.wrote).toBe(false)
      // ASKED, and the code recorded — this is not the "we never got that far" shape.
      expect(outcome.gatewayCode).toBe('E04111')
      expect(outcome.gatewayAskedAt).not.toBeNull()
    }
    expect(auditsFor(s.audits, HELD_CLEAR_SKIPPED_ACTION)).toHaveLength(6)
    expect(auditsFor(s.audits, ORDER_CANCELLED_ACTION)).toHaveLength(0)
  })
})

describe('the vocabulary', () => {
  it('has a staff line and an audit reason for every outcome, with no gaps', () => {
    for (const outcome of CLEAR_HELD_OUTCOMES) {
      expect(typeof CLEAR_HELD_OUTCOME_COPY[outcome as ClearHeldOutcome]).toBe('string')
      expect(CLEAR_HELD_OUTCOME_COPY[outcome as ClearHeldOutcome].length).toBeGreaterThan(0)
      expect(typeof CLEAR_HELD_OUTCOME_AUDIT_REASON[outcome as ClearHeldOutcome]).toBe('string')
      expect(CLEAR_HELD_OUTCOME_AUDIT_REASON[outcome as ClearHeldOutcome].length).toBeGreaterThan(0)
    }
  })

  it('has no name that merely says nothing happened', () => {
    /**
     * A bare `skipped`, `error`, `failed` or `unverifiable` is the silent skip with a label on it:
     * the reader learns that nothing happened and not why, which is the state this whole surface
     * exists to end. Every non-action outcome must carry a cause in its own name.
     *
     * `cancelled` is deliberately exempt: it is an ACTION, and it says precisely what was done.
     */
    const VAGUE = ['skipped', 'error', 'failed', 'unverifiable', 'unknown', 'other', 'deferred']
    for (const outcome of CLEAR_HELD_OUTCOMES) {
      expect(VAGUE).not.toContain(outcome)
      if (outcome === 'cancelled') continue
      expect(outcome.split('_').length).toBeGreaterThan(1)
    }
  })

  it('marks the four unsigned strings and ONLY those four', () => {
    /**
     * WAS "every string is unsigned". The owner signed twenty-six of them on 2026-08-27; the four
     * E04111 persistence refusals were written afterwards and are not signed.
     *
     * THIS ASSERTS BOTH DIRECTIONS, which is the only version worth having. "The four are marked"
     * on its own passes just as happily when a fifth string quietly loses its sign-off, and "no
     * string is marked" passes when somebody deletes a marker to get the production gate green —
     * the precise failure `check-no-pending-copy` exists to prevent. The intended set is written
     * down in `CLEAR_HELD_UNSIGNED_OUTCOMES` and the strings are checked against it.
     */
    for (const outcome of CLEAR_HELD_OUTCOMES) {
      const line = CLEAR_HELD_OUTCOME_COPY[outcome as ClearHeldOutcome]
      if (CLEAR_HELD_UNSIGNED_OUTCOMES.includes(outcome as ClearHeldOutcome)) {
        expect(line.startsWith(CLEAR_HELD_PENDING_COPY_MARKER)).toBe(true)
      } else {
        expect(line).not.toContain(CLEAR_HELD_PENDING_COPY_MARKER)
      }
    }
    // Exactly four, and they are the four named. Not "at least".
    expect(unsignedClearHeldStrings()).toHaveLength(CLEAR_HELD_UNSIGNED_OUTCOMES.length)
    expect(CLEAR_HELD_UNSIGNED_OUTCOMES).toHaveLength(4)
  })

  it('gives each of the four refusals its own name, its own line and its own audit reason', () => {
    /**
     * FOUR DISTINCT STAFF SITUATIONS, NOT ONE "skipped". Three of them resolve by waiting and
     * `no_attempt_timestamp` never does, so a staff member reading a merged line would wait for
     * something that is not coming. Distinctness is the property, so distinctness is the assertion.
     */
    const lines = CLEAR_HELD_UNSIGNED_OUTCOMES.map((o) => CLEAR_HELD_OUTCOME_COPY[o])
    const reasons = CLEAR_HELD_UNSIGNED_OUTCOMES.map((o) => CLEAR_HELD_OUTCOME_AUDIT_REASON[o])
    expect(new Set(CLEAR_HELD_UNSIGNED_OUTCOMES).size).toBe(4)
    expect(new Set(lines).size).toBe(4)
    expect(new Set(reasons).size).toBe(4)

    // The one that does NOT resolve by waiting must not tell anyone to run the check again.
    const stuck = CLEAR_HELD_OUTCOME_COPY.skipped_e04111_no_attempt_timestamp
    expect(stuck).toContain('Someone needs to look at this one.')
    expect(stuck).not.toMatch(/run the check again/i)
    // The three that DO resolve by waiting must all say so, or the staff member invents an action.
    for (const outcome of [
      'skipped_e04111_too_recent',
      'skipped_e04111_insufficient_observations',
      'skipped_e04111_observations_too_close_together',
    ] as const) {
      expect(CLEAR_HELD_OUTCOME_COPY[outcome]).toMatch(/run the check again/i)
    }
  })
})
