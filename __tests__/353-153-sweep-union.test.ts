/**
 * #353 ON TOP OF #153 — the properties that exist only once both are in the same function, and
 * which neither issue's own suite can assert.
 *
 * The two changes rewrote the same twenty lines of `autoCancelStalePosOrders` and were resolved by
 * hand on 2026-08-27. They are compatible in principle — different fields on the same result
 * object, different branches of the same partition — but "compatible in principle" is exactly the
 * claim that a merge is capable of quietly breaking, because each suite passes against its own
 * half.
 *
 * WHAT IS ACTUALLY AT RISK, and why each test below exists:
 *
 *  1. #153's hold is a WRITE, made from inside the Finatic catch. #353's whole guarantee is that a
 *     non-POS order is "not cancelled, not probed, NOT WRITTEN TO". The hold is a fourth write on
 *     that path and it landed after #353 was authored, so #353's suite has never seen it. If the
 *     partition were ever moved below the Finatic loop — the single most plausible future edit to
 *     this function — a `table` order at a venue with no credentials would be moved to
 *     `verification_unavailable_hold` and every test in both suites would still pass.
 *
 *  2. `finalise()` is #153's, and #353 added a THIRD early return in front of it. Every count on
 *     the merged result object must equal the length of its own id list at every exit, including
 *     the fields the other issue owns.
 *
 *  3. `HELD_FOR_REVIEW_PAYMENT_STATUSES` gained its second member in the merge.
 *     `selectHeldForReviewOrders` can therefore DETECT `verification_unavailable_hold` for the
 *     first time. #353 could only assert the owner-pinned sentence for that cause through the
 *     `buildHeldForReviewRow` seam, because on its own branch no fixture could produce the row.
 *     Here it can, so the sentence is asserted through the path staff actually reach.
 *
 * The negative assertions are the load-bearing ones, as in #353's suite: the stored fixtures are
 * inspected for the payment_status the code wrote, and the audit rows are counted. A test that
 * only read the result object would pass with a write happening beside it.
 */
import {
  autoCancelStalePosOrders,
  VERIFICATION_UNAVAILABLE_HELD_ACTION,
  type AutoCancelStalePosOrdersResult,
} from '@/lib/orders/auto-cancel-stale-pos-orders'
import { VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS } from '@/lib/payments/payment-integrity'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  HELD_FOR_REVIEW_CAUSE_COPY,
  selectHeldForReviewOrders,
  STRANDED_PENDING_THRESHOLD_MS,
} from '@/lib/orders/held-for-review'

const RESTAURANT = 'rest-no-credentials'

type Row = Record<string, unknown>

type OrderRow = {
  id: string
  restaurant_id: string
  total: number
  channel: string | null
  paycloud_merchant_order_no: string | null
  payment_status: string
  status?: string
}

/**
 * The storing PostgREST double from #153's suite, with `channel` carried on the row so #353's
 * partition is real here. `.eq()` is applied to reads AND writes, which is what makes an assertion
 * about a fixture's payment_status an assertion about what the code wrote.
 */
function makeSupabase(orders: OrderRow[]) {
  const audits: Row[] = []

  const client = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      const chain: Record<string, unknown> = {}
      const self = () => chain

      const matching = () =>
        orders.filter((o) =>
          eqs.every(([col, val]) => String((o as Row)[col] ?? '') === String(val)),
        )

      const resolve = () => {
        if (table === 'audit_logs') return { data: [], error: null }
        if (op === 'update') {
          const hit = matching()
          for (const row of hit) Object.assign(row, patch)
          return { data: hit.map((o) => ({ id: o.id })), error: null }
        }
        return { data: matching(), error: null }
      }

      chain.select = () => self()
      chain.insert = (row: Row) => {
        if (table === 'audit_logs') audits.push(row)
        return { error: null }
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
      // placed_at is not modelled; every fixture is older than the stale cutoff by construction.
      chain.lt = () => self()
      chain.in = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.range = (from: number) =>
        Promise.resolve(from === 0 ? resolve() : { data: [], error: null })
      chain.then = (onResolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onResolve)
      return chain
    },
  }

  return { client: client as never, audits, orders }
}

const getCredentials = jest.fn()
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: (...args: unknown[]) => getCredentials(...args),
}))

beforeEach(() => {
  getCredentials.mockReset()
  getCredentials.mockImplementation(async (rid: string) => {
    throw new MissingFinaticCredentialsError(String(rid))
  })
})

const posWithRef = (): OrderRow => ({
  id: 'pos-with-ref',
  restaurant_id: RESTAURANT,
  total: 41,
  channel: 'pos',
  paycloud_merchant_order_no: 'FT-POS-1',
  payment_status: 'pending',
})
const tableWithRef = (): OrderRow => ({
  id: 'table-with-ref',
  restaurant_id: RESTAURANT,
  total: 50,
  channel: 'table',
  paycloud_merchant_order_no: 'FT-TABLE-1',
  payment_status: 'pending',
})
const kioskNoRef = (): OrderRow => ({
  id: 'kiosk-no-ref',
  restaurant_id: RESTAURANT,
  total: 3,
  channel: 'kiosk',
  paycloud_merchant_order_no: null,
  payment_status: 'pending',
})

describe("#153's hold never reaches a channel #353 only surfaces", () => {
  it('holds the POS order and leaves the non-POS ones beside it completely untouched', async () => {
    const probe = jest.fn()
    const fixtures = [posWithRef(), tableWithRef(), kioskNoRef()]
    const { client, audits, orders } = makeSupabase(fixtures)

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: probe as never,
    })

    // #153's half, unchanged by the merge.
    expect(result.heldVerificationUnavailableIds).toEqual(['pos-with-ref'])
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)

    // #353's half. THE ASSERTION THIS FILE EXISTS FOR: the hold is a write, and it must not have
    // been made to a channel the sweep may only look at. Read off the stored rows, not the result.
    expect(orders[1].payment_status).toBe('pending')
    expect(orders[2].payment_status).toBe('pending')
    expect(result.surfacedNeedsHumanIds.sort()).toEqual(['kiosk-no-ref', 'table-with-ref'])

    // Exactly one audit row, for exactly one order. A hold written to a surfaced order would show
    // up here even if the status write were somehow missed above.
    const held = audits.filter((a) => a.action === VERIFICATION_UNAVAILABLE_HELD_ACTION)
    expect(held).toHaveLength(1)
    expect(held[0].entity_id).toBe('pos-with-ref')

    // kiosk-no-ref carries no gateway reference, which on the POS path is the branch that cancels
    // outright. It must not have been reached.
    expect(result.cancelledIds).toEqual([])
    // And the gateway was never asked about anything -- the credentials throw precedes the probe.
    expect(probe).not.toHaveBeenCalled()
  })

  it('a non-POS order at a venue with no credentials is surfaced, never held', async () => {
    // The single-order form of the same claim, so the property is not an accident of the fixture
    // set above. This is the order that would be silently held if the partition ever moved below
    // the Finatic loop.
    const fixtures = [tableWithRef()]
    const { client, audits, orders } = makeSupabase(fixtures)

    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: true })

    expect(result.heldVerificationUnavailableIds).toEqual([])
    expect(result.heldVerificationUnavailableCount).toBe(0)
    expect(result.skippedUncertainIds).toEqual([])
    expect(orders[0].payment_status).toBe('pending')
    expect(audits).toEqual([])
    expect(result.surfacedNeedsHumanIds).toEqual(['table-with-ref'])
  })
})

describe('every count on the merged result is derived from its own id list, at every exit', () => {
  /**
   * `finalise()` is #153's, and #353 put a third early return in front of it. Both issues' fields
   * are checked at each exit, because the failure mode is asymmetric: whichever field is populated
   * BEFORE the return that skips finalise is the one that reports zero, and the release pass runs
   * before all three.
   */
  const assertCountsAgree = (result: AutoCancelStalePosOrdersResult) => {
    expect(result.cancelledCount).toBe(result.cancelledIds.length)
    expect(result.correctedToPaidCount).toBe(result.correctedToPaidIds.length)
    expect(result.skippedUncertainCount).toBe(result.skippedUncertainIds.length)
    expect(result.heldForAmountReviewCount).toBe(result.heldForAmountReviewIds.length)
    expect(result.heldVerificationUnavailableCount).toBe(
      result.heldVerificationUnavailableIds.length,
    )
    expect(result.releasedVerificationUnavailableCount).toBe(
      result.releasedVerificationUnavailableIds.length,
    )
    expect(result.surfacedNeedsHumanCount).toBe(result.surfacedNeedsHumanIds.length)
    expect(result.surfacedNeedsHumanCount).toBe(result.surfacedNeedsHuman.length)
  }

  it('on the no-candidates exit', async () => {
    const { client } = makeSupabase([])
    assertCountsAgree(await autoCancelStalePosOrders(client, { verifyWithFinatic: true }))
  })

  it('on the no-POS-rows exit, which #353 added in front of finalise', async () => {
    const { client } = makeSupabase([tableWithRef(), kioskNoRef()])
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: true })
    expect(result.surfacedNeedsHumanCount).toBe(2)
    assertCountsAgree(result)
  })

  it('on the full exit, with both issues firing on the same run', async () => {
    const { client } = makeSupabase([posWithRef(), tableWithRef(), kioskNoRef()])
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: true })
    expect(result.heldVerificationUnavailableCount).toBe(1)
    expect(result.surfacedNeedsHumanCount).toBe(2)
    assertCountsAgree(result)
  })
})

describe("the staff surface can DETECT #153's hold now, not merely render a hand-built row", () => {
  it('routes verification_unavailable_hold through selectHeldForReviewOrders with the pinned sentence', async () => {
    // On #353's own branch HELD_FOR_REVIEW_PAYMENT_STATUSES had one member, so no fixture could
    // reach this cause through the selector and the owner-pinned sentence could only be asserted
    // against a constant or through the buildHeldForReviewRow seam. The merge makes the real path
    // reachable; this asserts it there.
    const rows = selectHeldForReviewOrders([
      {
        id: 'held-1',
        payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
        status: 'ready',
        total: 41,
        // Deliberately YOUNGER than the stranded threshold: a gateway has already answered about
        // a held order, so it needs a person now and must not have to age onto the screen.
        placed_at: new Date(Date.now() - 60 * 1000).toISOString(),
        channel: 'pos',
        table_number: 0,
        paycloud_merchant_order_no: 'FT-POS-1',
      },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].cause).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
    expect(rows[0].copySigned).toBe(true)
    expect(rows[0].why).toBe(
      HELD_FOR_REVIEW_CAUSE_COPY.verification_unavailable_hold.why,
    )
    expect(rows[0].why).toContain('A card may still have been charged on the machine.')
    // And NOT the opposite sentence, which belongs to the amount-mismatch cause and would tell a
    // staff member they may act without checking the terminal roll.
    expect(rows[0].why).not.toContain('Nothing has been taken from this order yet.')
  })

  it('a held order is on the panel and NOT in the cron sweep’s surfaced list', async () => {
    // The two surfaces must not both claim the same order under different reasoning. A held order
    // is no longer `pending`, so it drops out of the candidate query by construction -- which is
    // what terminates #153's loop, and is asserted here from the other side.
    const fixtures: OrderRow[] = [
      {
        id: 'already-held',
        restaurant_id: RESTAURANT,
        total: 41,
        channel: 'pos',
        paycloud_merchant_order_no: 'FT-POS-1',
        payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
      },
    ]
    const { client } = makeSupabase(fixtures)
    // No credentials, so the release pass leaves it held -- the state lasts as long as its cause.
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: true })

    expect(result.surfacedNeedsHumanIds).toEqual([])
    expect(result.releasedVerificationUnavailableIds).toEqual([])
    expect(fixtures[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)

    expect(
      selectHeldForReviewOrders(
        [
          {
            id: 'already-held',
            payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
            total: 41,
            placed_at: new Date(Date.now() - STRANDED_PENDING_THRESHOLD_MS).toISOString(),
            channel: 'pos',
          },
        ],
        Date.now(),
      ),
    ).toHaveLength(1)
  })
})
