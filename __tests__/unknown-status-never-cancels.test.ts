import {
  autoCancelStalePosOrders,
  VERIFICATION_SKIPPED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'
import {
  isCancelledOnE04111Evidence,
  NON_RECOVERABLE_CANCELLATION_REASON_PREFIXES,
} from '@/lib/payments/e04111-recovery'

/**
 * UNKNOWN NEVER AUTHORISES A CANCEL — and a genuine not-paid must still behave exactly as before.
 *
 * `paid` is a boolean, so before this change every trans_status that was not 2 fell through to the
 * cancel branch. Nobody has the enum: measured 2026-08-21, no vendor documentation of trans_status
 * exists on either drive, and only 1 and 2 were observed across 43 live calls. A 3 would have
 * cancelled a real customer's order on a card that may have cleared.
 *
 * BOTH DIRECTIONS ARE ASSERTED HERE, because a one-sided fix is how you turn a cancel bug into a
 * never-cancels bug and stop the queue draining at all.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-1'
const MON = 'FT-TEST-0001'

type Row = Record<string, unknown>
const orderRow = () => ({
  id: ORDER,
  restaurant_id: RESTAURANT,
  total: 33,
  // #353: the sweep now reads EVERY channel and filters at the partition, so `channel` is
  // load-bearing in this fixture. It was implicitly 'pos' before -- the candidate query carried
  // .eq('channel','pos'), so no other value could ever reach the code under test. An absent
  // channel is deliberately NOT treated as 'pos': unknown is not not-paid, and it is not POS either.
  channel: 'pos',
  paycloud_merchant_order_no: MON,
})

function makeSupabase() {
  const inserted: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      const st = { isAuditSelect: false }
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = () => {
        if (table === 'audit_logs') st.isAuditSelect = true
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
      chain.eq = () => self()
      chain.lt = () => self()
      chain.in = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0
            ? { data: [orderRow()], error: null }
            : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && st.isAuditSelect) {
          return Promise.resolve({ data: [], error: null }).then(resolve)
        }
        if (table === 'orders') {
          return Promise.resolve({ data: [{ id: ORDER }], error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, updates }
}

const reply = (over: Partial<Record<string, unknown>>) =>
  async () =>
    ({
      paid: false,
      statusRecognised: true,
      merchantOrderNo: MON,
      status: 'failed',
      transactionId: null,
      amount: 0,
      raw: {},
      ...over,
    }) as never

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

describe('an UNRECOGNISED gateway status', () => {
  it('does NOT cancel the order', async () => {
    const { client, updates } = makeSupabase()
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: false, status: '3' }),
    })
    expect(result.cancelledIds).not.toContain(ORDER)
    expect(updates.some((u) => u.status === 'cancelled')).toBe(false)
    expect(result.skippedUncertainIds).toContain(ORDER)
  })

  it('records the unrecognised value verbatim, so a 3 is found in the DB not in a cancelled order', async () => {
    const { client, inserted } = makeSupabase()
    await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: false, status: '3' }),
    })
    const row = inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)
    expect(row).toBeDefined()
    const meta = row!.metadata as Row
    expect(meta.unrecognisedStatus).toBe(true)
    expect(meta.gatewayStatus).toBe('3')
  })
})

describe('a GENUINE not-paid response — unchanged behaviour', () => {
  it('still cancels the order, exactly as before', async () => {
    // The other side of the asymmetry. If this stops cancelling, the queue never drains and the
    // fix has traded one defect for another.
    const { client } = makeSupabase()
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: true, status: 'failed' }),
    })
    expect(result.cancelledIds).toContain(ORDER)
    expect(result.skippedUncertainIds).not.toContain(ORDER)
  })

  it('writes no unrecognised-status audit row for it', async () => {
    const { client, inserted } = makeSupabase()
    await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: true, status: 'failed' }),
    })
    const row = inserted.find((r) => (r.metadata as Row | undefined)?.unrecognisedStatus === true)
    expect(row).toBeUndefined()
  })
})

describe('recoverability after cancellation', () => {
  const cancelled = (reason: string) => ({ payment_status: 'cancelled', cancellation_reason: reason })

  it('revives the reasons that were silently unrecoverable before', () => {
    // The 27 measured on production: 9 operator-ruling + ~18 manual portal confirmations.
    expect(isCancelledOnE04111Evidence(cancelled('operator_ruling_finatic_confirmed_unpaid_20260821'))).toBe(true)
    expect(
      isCancelledOnE04111Evidence(
        cancelled('Cancelled on MANUAL confirmation via the Finatic portal that no charge landed'),
      ),
    ).toBe(true)
    // And the two the old allowlist already covered.
    expect(isCancelledOnE04111Evidence(cancelled('auto_cancelled_e04111_persistent'))).toBe(true)
    expect(isCancelledOnE04111Evidence(cancelled('no_payment_attempt_made'))).toBe(true)
  })

  it('still refuses the deliberate-death reasons', () => {
    for (const p of NON_RECOVERABLE_CANCELLATION_REASON_PREFIXES) {
      expect(isCancelledOnE04111Evidence(cancelled(p))).toBe(false)
    }
    // Prefix-matched, so appended detail does not smuggle one through.
    expect(isCancelledOnE04111Evidence(cancelled('staff_cancelled: wrong table'))).toBe(false)
    expect(isCancelledOnE04111Evidence(cancelled('auto_timeout'))).toBe(false)
  })

  it('fails TOWARD recovery for a reason nobody has classified yet', () => {
    // Deliberate: the recovery only fires on a PROVEN payment. Discarding a real payment is the
    // worse failure, so an unclassified reason must not be silently unrecoverable.
    expect(isCancelledOnE04111Evidence(cancelled('some_rule_invented_next_year'))).toBe(true)
  })

  it('never revives an order that is not cancelled', () => {
    expect(isCancelledOnE04111Evidence({ payment_status: 'paid', cancellation_reason: 'whatever' })).toBe(false)
    expect(isCancelledOnE04111Evidence(null)).toBe(false)
  })
})
