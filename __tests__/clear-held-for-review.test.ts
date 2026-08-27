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
  unsignedClearHeldStrings,
} from '@/lib/orders/clear-held-for-review-copy'
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
    tab_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    ...partial,
  }
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
function makeSupabase(orders: OrderFixture[]) {
  const audits: Row[] = []
  const updates: UpdateCall[] = []

  const client = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      const ins: Array<[string, unknown[]]> = []
      const lts: Array<[string, unknown]> = []
      const notNulls: string[] = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
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
        if (table === 'audit_logs') return { data: [], error: null }
        if (table === 'tabs') return { data: [], error: null }
        if (op === 'update') {
          const hit = matching()
          updates.push({ table, patch: { ...patch }, filters: [...eqs] })
          for (const row of hit) Object.assign(row, patch)
          return { data: hit.map((row) => ({ ...row })), error: null }
        }
        return { data: matching().map((row) => ({ ...row })), error: null }
      }

      chain.select = () => self()
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

  it('marks EVERY staff-facing string as unsigned, because not one has been signed off', () => {
    const unsigned = unsignedClearHeldStrings()
    for (const outcome of CLEAR_HELD_OUTCOMES) {
      expect(CLEAR_HELD_OUTCOME_COPY[outcome as ClearHeldOutcome]).toContain(
        CLEAR_HELD_PENDING_COPY_MARKER,
      )
    }
    // The count is not pinned — it will change as strings are signed. What is pinned is that
    // nothing has escaped the marker.
    expect(unsigned.length).toBeGreaterThanOrEqual(CLEAR_HELD_OUTCOMES.length)
  })
})
