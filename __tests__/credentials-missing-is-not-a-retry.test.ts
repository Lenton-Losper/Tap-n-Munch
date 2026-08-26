/**
 * #153 — "credentials missing" is not "the gateway is down", and only one of the two is worth
 * retrying.
 *
 * THE DEFECT. The stale-POS sweep's catch handled three conditions with one branch — Finatic
 * unreachable, Finatic errored, and no credentials configured — and answered all three by leaving
 * the order `pending` for the next run. The first two are transient and retrying is correct. The
 * third is a closed loop: the retry waits on something external to change, and nothing external is
 * involved. Measured on production 2026-08-26, the sibling E04111 case had reached 93 re-probes
 * per order across four days, and this case's one realised instance (Digi Cofee #19) sat pending
 * for nine days until a human cancelled it by hand.
 *
 * WHAT IS ASSERTED, AND WHAT IS NOT. These tests assert the DISCRIMINATION and the STATE it
 * produces, in both directions — a credentials throw must hold, and an ordinary throw must still
 * skip. A test that only proved the hold happens would be satisfied by deleting the discriminator
 * and holding everything, which would take the E04111 orders out of a retry that can still
 * succeed.
 *
 * The supabase double models the ROW, not the rule: it stores payment_status and honours the
 * `.eq()` guards, so an assertion about the status is an assertion about what the code wrote, not
 * a restatement of the branch that wrote it.
 *
 * NOT CANCELLING is asserted everywhere, because it is the money-path property. Nothing here
 * establishes that no card was charged.
 */
import {
  autoCancelStalePosOrders,
  VERIFICATION_SKIPPED_ACTION,
  VERIFICATION_UNAVAILABLE_HELD_ACTION,
  VERIFICATION_UNAVAILABLE_RELEASED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'
import { VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS } from '@/lib/payments/payment-integrity'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'

const RESTAURANT = 'rest-no-credentials'
const ORDER = 'order-at-an-unconfigured-venue'
const MERCHANT_ORDER_NO = 'FT-TEST-0153'

type Row = Record<string, unknown>

type OrderRow = {
  id: string
  restaurant_id: string
  total: number
  paycloud_merchant_order_no: string | null
  channel: string
  payment_status: string
  status?: string
  cancellation_reason?: string | null
}

const pendingOrder = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: ORDER,
  restaurant_id: RESTAURANT,
  total: 41,
  paycloud_merchant_order_no: MERCHANT_ORDER_NO,
  channel: 'pos',
  payment_status: 'pending',
  ...over,
})

/**
 * A PostgREST double that stores rows. `.eq()` filters are recorded and applied on both reads and
 * writes, which is what makes the concurrency guards (`.eq('payment_status', 'pending')`) real
 * here rather than decorative — an update whose guard does not match the stored row matches
 * nothing and returns no data, exactly as the database would.
 */
function makeSupabase(orders: OrderRow[], priorSkips: Row[] = []) {
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
        if (table === 'audit_logs') return { data: priorSkips, error: null }
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

// ------------------------------------------------------------------ credential seam

/**
 * Mocked per test. The module under test imports the PREDICATE from
 * '@/lib/payments/finatic-credentials-error', which is deliberately NOT mocked — see that file
 * for why. So this factory can stay the minimal one every other suite uses.
 */
const getCredentials = jest.fn()
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: (...args: unknown[]) => getCredentials(...args),
}))

const credentialsMissing = () => {
  getCredentials.mockImplementation(async (rid: string) => {
    throw new MissingFinaticCredentialsError(String(rid))
  })
}
const credentialsPresent = () => {
  getCredentials.mockImplementation(async () => ({ merchantNo: 'm', storeNo: 's' }))
}

/** Finatic unreachable — the TRANSIENT condition that must keep its retry. */
const unreachable = () => {
  throw new Error('fetch failed: ETIMEDOUT')
}

beforeEach(() => {
  getCredentials.mockReset()
})

describe('the stale-POS sweep, when the venue has no Finatic credentials', () => {
  it('takes the order OUT of the retry loop instead of skipping it again', async () => {
    credentialsMissing()
    const probe = jest.fn(unreachable)
    const { client, audits, orders } = makeSupabase([pendingOrder()])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: probe as never,
    })

    // The gateway is never asked. There is nothing to ask it with.
    expect(probe).not.toHaveBeenCalled()

    expect(result.heldVerificationUnavailableIds).toEqual([ORDER])
    expect(result.heldVerificationUnavailableCount).toBe(1)
    // A held order was NOT skipped. Counting it as a skip would keep it inside the number the
    // cron logs as "retrying next run", which is the ambiguity the issue is about.
    expect(result.skippedUncertainIds).not.toContain(ORDER)
    expect(audits.find((a) => a.action === VERIFICATION_SKIPPED_ACTION)).toBeUndefined()

    // The state is POSITIVELY IDENTIFIABLE, not an absence. `pending` is also what an order the
    // sweep has not reached looks like.
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)

    const held = audits.find((a) => a.action === VERIFICATION_UNAVAILABLE_HELD_ACTION)
    expect(held).toBeDefined()
    expect(held!.entity_id).toBe(ORDER)
    expect((held!.metadata as Row).chargeStatus).toBe('unknown')
    expect((held!.metadata as Row).businessOrderNo).toBe(MERCHANT_ORDER_NO)
  })

  it('does NOT cancel it — charge status is unknown, not absent', async () => {
    credentialsMissing()
    const { client, orders } = makeSupabase([pendingOrder()])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: unreachable as never,
    })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(result.cancelledCount).toBe(0)
    expect(orders[0].status).toBeUndefined()
    expect(orders[0].payment_status).not.toBe('cancelled')
  })

  it('and the loop TERMINATES — three consecutive runs hold it once and then leave it alone', async () => {
    // The property the issue actually asks for. Ninety-three identical probes is the failure;
    // one hold and then silence is the fix.
    credentialsMissing()
    const probe = jest.fn(unreachable)
    const { client, audits, orders } = makeSupabase([pendingOrder()])

    for (let run = 0; run < 3; run++) {
      await autoCancelStalePosOrders(client, {
        verifyWithFinatic: true,
        queryFinaticOrderPaidFn: probe as never,
      })
    }

    expect(probe).not.toHaveBeenCalled()
    expect(audits.filter((a) => a.action === VERIFICATION_UNAVAILABLE_HELD_ACTION)).toHaveLength(1)
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
  })
})

describe('the same sweep, when Finatic is merely unreachable', () => {
  it('still SKIPS and still retries — the transient case keeps its old behaviour', async () => {
    // The other direction. Without this, deleting the discriminator and holding every failure
    // would satisfy the tests above while quietly ending the retry for orders whose next probe
    // could genuinely succeed (E04111 is time-dependent: order #149 answered E04111 and was
    // confirmed paid on the same reference 22 seconds later).
    credentialsPresent()
    const { client, audits, orders } = makeSupabase([pendingOrder()])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: unreachable as never,
    })

    expect(result.skippedUncertainIds).toEqual([ORDER])
    expect(result.heldVerificationUnavailableIds).toHaveLength(0)
    expect(orders[0].payment_status).toBe('pending')
    expect(audits.find((a) => a.action === VERIFICATION_SKIPPED_ACTION)).toBeDefined()
    expect(audits.find((a) => a.action === VERIFICATION_UNAVAILABLE_HELD_ACTION)).toBeUndefined()
  })
})

describe('the hold is not a dead end', () => {
  it('releases a held order back to pending once the venue HAS credentials', async () => {
    // Otherwise the fix trades a forever-retry for a forever-hold. The live shape of #153 is a
    // venue onboarded before its credentials are entered — 8 of 11 production venues have none —
    // so the hold must end by itself the day someone fills the fields in.
    credentialsPresent()
    const { client, audits, orders } = makeSupabase([
      pendingOrder({ payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS }),
    ])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: unreachable as never,
    })

    expect(result.releasedVerificationUnavailableIds).toEqual([ORDER])
    expect(result.releasedVerificationUnavailableCount).toBe(1)
    expect(audits.find((a) => a.action === VERIFICATION_UNAVAILABLE_RELEASED_ACTION)).toBeDefined()
    // Released and then verified on the SAME run: the sweep re-reads candidates afterwards, so
    // the order is probed rather than waiting another two minutes. Finatic is unreachable in this
    // fixture, so it lands on the ordinary skip — which is the correct outcome for a live venue.
    expect(result.skippedUncertainIds).toContain(ORDER)
    expect(orders[0].payment_status).toBe('pending')
  })

  it('does NOT release while the credentials are still missing', async () => {
    credentialsMissing()
    const { client, audits, orders } = makeSupabase([
      pendingOrder({ payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS }),
    ])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: unreachable as never,
    })

    expect(result.releasedVerificationUnavailableIds).toHaveLength(0)
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
    expect(audits.find((a) => a.action === VERIFICATION_UNAVAILABLE_RELEASED_ACTION)).toBeUndefined()
  })

  it('does NOT release on an unrelated credential-read failure — unknown is not configured', async () => {
    // Releasing on a failed read would hand the order back to a sweep that could then cancel it
    // on a Finatic answer it never really obtained.
    getCredentials.mockImplementation(async () => {
      throw new Error('restaurant cache read exploded')
    })
    const { client, orders } = makeSupabase([
      pendingOrder({ payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS }),
    ])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: unreachable as never,
    })

    expect(result.releasedVerificationUnavailableIds).toHaveLength(0)
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
  })

  it('leaves held orders alone on the terminal’s lazy-cleanup call (verifyWithFinatic false)', async () => {
    // That call must stay on the free, no-network branch.
    credentialsPresent()
    const { client, orders } = makeSupabase([
      pendingOrder({ payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS }),
    ])

    const result = await autoCancelStalePosOrders(client, {})

    expect(result.releasedVerificationUnavailableIds).toHaveLength(0)
    expect(orders[0].payment_status).toBe(VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
  })
})
