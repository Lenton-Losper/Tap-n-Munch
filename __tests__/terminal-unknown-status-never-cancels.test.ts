/**
 * D-1, D-2 and D-4 — what a terminal payment failure is allowed to conclude, and what it records.
 *
 * ================================================================================================
 * D-1 — AN UNRECOGNISED FINATIC STATUS MUST NEVER AUTHORISE A CANCEL
 * ================================================================================================
 *
 * `queryFinaticOrderPaid` returns `paid` as a boolean, so every value the gateway could return that
 * is not a recognised success collapses into "not paid". `handleTerminalPaymentFailed` cancelled on
 * that boolean alone: it wrote payment_status='cancelled' on an order whose card may well have
 * cleared, and the terminal then rendered "Payment failed" in red.
 *
 * The producer states the contract in the opposite direction and names this caller's obligation:
 * "A caller that CANCELS on not-paid must check this first." Three other cancel paths already do
 * (auto-cancel-stale-pos-orders, override-cancel, clear-held-for-review). This one did not.
 *
 * NOBODY HAS THE ENUM. Across 43 live order.query calls measured over four weeks, only
 * trans_status 1 and 2 have ever been observed, and no vendor documentation of the field exists.
 * A 3 would have cancelled a real customer's order.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS RATHER THAN MORE CASES IN AN OLD ONE
 * ================================================================================================
 *
 * Ten test files exercise handleTerminalPaymentFailed and not one of them mentioned
 * `statusRecognised` — which is exactly how the gap survived. The four outcomes are pinned here
 * together, as a table, so the next person changing this function sees all of them at once.
 *
 * WHAT MAKES THESE TESTS GO RED. Verified by mutation, 2026-09-16:
 *   delete the `if (!finatic.statusRecognised)` guard  -> the three D-1 unknown-status tests fail
 *   evidence_basis back to the old binary ternary      -> the two D-2 tests fail
 *   drop gatewayResult from the audit metadata         -> the three D-4 tests fail
 */
// `@/payments/paycloud` is untransformed ESM and is only reachable via the real Finatic path,
// which every test here injects around.
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: jest.fn(async () => {
    throw new Error('queryPaymentOrder must not be reached — tests inject queryFinaticOrderPaidFn')
  }),
}))

import {
  CANCEL_EVIDENCE_BASES,
  handleTerminalPaymentFailed,
  TERMINAL_USER_CANCELLED_REASON,
} from '@/lib/payments/handle-terminal-payment-failed'
import { VERIFICATION_SKIPPED_ACTION } from '@/lib/orders/auto-cancel-stale-pos-orders'

const MERCHANT_ORDER_NO = 'FT17860156979870443'
const ORDER_TOTAL = 40

type Row = Record<string, unknown>

function makeSupabase() {
  const audits: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: (row: Row) => {
            audits.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'orders') {
        const builder: Record<string, unknown> = {
          update(patch: Row) {
            updates.push(patch)
            return builder
          },
          eq() {
            return builder
          },
          in() {
            return builder
          },
          select() {
            return builder
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'order-1', status: 'cancelled', payment_status: 'cancelled' },
              error: null,
            })
          },
          single() {
            return Promise.resolve({ data: { id: 'order-1' }, error: null })
          },
          then(resolve: (r: { data: Row[]; error: null }) => unknown) {
            return Promise.resolve(resolve({ data: [{ id: 'order-1' }], error: null }))
          },
        }
        return builder
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      }
    },
  }
  return { client: client as never, audits, updates }
}

function baseParams(over: Row = {}) {
  return {
    orderId: 'order-1',
    restaurantId: 'rest-1',
    paycloudMerchantOrderNo: MERCHANT_ORDER_NO,
    orderTotal: ORDER_TOTAL,
    amount: ORDER_TOTAL,
    reference: 'UNCONFIRMED-x',
    ...over,
  } as never
}

/**
 * A Finatic answer, shaped as the REAL queryFinaticOrderPaid shapes one — every field present,
 * because a stub that omits `statusRecognised` models a response the gateway cannot return and
 * would make the guard under test unreachable.
 */
function answer(over: Partial<{
  paid: boolean
  statusRecognised: boolean
  status: string
  amount: number | null
  transactionId: string | null
}> = {}) {
  const calls: unknown[] = []
  const value = {
    paid: false,
    statusRecognised: true,
    status: 'failed',
    merchantOrderNo: MERCHANT_ORDER_NO,
    transactionId: null,
    amount: null,
    raw: {},
    ...over,
  }
  return {
    calls,
    fn: (async (args: unknown) => {
      calls.push(args)
      return value
    }) as never,
  }
}

const lastAudit = (audits: Row[]) => audits.at(-1)!
const meta = (audits: Row[]) => lastAudit(audits).metadata as Row

// ── D-1: the four outcomes, as a table ───────────────────────────────────────

describe('D-1 — what each Finatic answer is allowed to conclude', () => {
  test('recognised NOT PAID → cancelled', async () => {
    const { client, audits, updates } = makeSupabase()
    const q = answer({ paid: false, statusRecognised: true, status: 'failed' })

    const res = await handleTerminalPaymentFailed(client, baseParams(), {
      queryFinaticOrderPaidFn: q.fn,
    })

    expect(q.calls).toHaveLength(1)
    expect(res.outcome).toBe('cancelled')
    expect(updates.at(-1)).toMatchObject({ payment_status: 'cancelled' })
  })

  test('UNRECOGNISED status → left_pending_finatic_uncertain, and NOTHING is written to the order', async () => {
    const { client, audits, updates } = makeSupabase()
    // trans_status 3: never observed, no vendor enum, therefore unreadable.
    const q = answer({ paid: false, statusRecognised: false, status: '3' })

    const res = await handleTerminalPaymentFailed(client, baseParams(), {
      queryFinaticOrderPaidFn: q.fn,
    })

    expect(res.outcome).toBe('left_pending_finatic_uncertain')
    // THE WHOLE DEFECT, IN ONE ASSERTION: the order must not have been touched.
    expect(updates).toHaveLength(0)
  })

  test('the unrecognised value is recorded verbatim, not merely skipped', async () => {
    const { client, audits } = makeSupabase()
    const q = answer({ paid: false, statusRecognised: false, status: 'settling' })

    await handleTerminalPaymentFailed(client, baseParams(), { queryFinaticOrderPaidFn: q.fn })

    expect(lastAudit(audits).action).toBe(VERIFICATION_SKIPPED_ACTION)
    expect(meta(audits)).toMatchObject({
      source: 'terminal_payment_failed',
      finaticStatus: 'settling',
      statusRecognised: false,
      outcome: 'left_pending_finatic_uncertain',
      businessOrderNo: MERCHANT_ORDER_NO,
    })
    // If Finatic ever returns a third value the owner finds out from the database, not from a
    // cancelled customer order.
    expect(String(meta(audits).reason)).toContain('settling')
  })

  test('an unrecognised status that is also PAID is still never cancelled', async () => {
    // Belt and braces: `paid` is checked first, so this returns corrected_to_paid or leaves it
    // pending — but it must never reach the cancel under any combination.
    const { client, updates } = makeSupabase()
    const q = answer({ paid: true, statusRecognised: false, status: '9', amount: ORDER_TOTAL })

    const res = await handleTerminalPaymentFailed(client, baseParams(), {
      queryFinaticOrderPaidFn: q.fn,
    })

    expect(res.outcome).not.toBe('cancelled')
    expect(updates.every((u) => u.payment_status !== 'cancelled')).toBe(true)
  })

  test('PAID with a matching amount → corrected_to_paid', async () => {
    const { client } = makeSupabase()
    const q = answer({ paid: true, statusRecognised: true, status: 'paid', amount: ORDER_TOTAL })

    const res = await handleTerminalPaymentFailed(client, baseParams(), {
      queryFinaticOrderPaidFn: q.fn,
    })

    expect(res.outcome).toBe('corrected_to_paid')
  })

  test('PAID with a mismatching amount → left_pending_finatic_uncertain, never cancelled', async () => {
    const { client, updates } = makeSupabase()
    const q = answer({ paid: true, statusRecognised: true, status: 'paid', amount: ORDER_TOTAL + 5 })

    const res = await handleTerminalPaymentFailed(client, baseParams(), {
      queryFinaticOrderPaidFn: q.fn,
    })

    expect(res.outcome).toBe('left_pending_finatic_uncertain')
    expect(updates).toHaveLength(0)
  })

  test('a user cancel still bypasses verification entirely — the guard did not widen the gate', async () => {
    const { client } = makeSupabase()
    const q = answer({ paid: false, statusRecognised: false, status: '3' })

    const res = await handleTerminalPaymentFailed(
      client,
      baseParams({
        cancellationReason: TERMINAL_USER_CANCELLED_REASON,
        noGatewayAttempt: true,
      }),
      { queryFinaticOrderPaidFn: q.fn },
    )

    expect(q.calls).toHaveLength(0)
    expect(res.outcome).toBe('cancelled')
  })
})

// ── D-2: the audit row must not claim a verification that did not happen ─────

describe('D-2 — a cancellation records how it actually knows', () => {
  test('no merchant order number → no_attempt_recorded, and charge status is NOT claimed as known', async () => {
    const { client, audits } = makeSupabase()
    const q = answer({ paid: false })

    const res = await handleTerminalPaymentFailed(
      client,
      baseParams({ paycloudMerchantOrderNo: null }),
      { queryFinaticOrderPaidFn: q.fn },
    )

    expect(res.outcome).toBe('cancelled')
    // Nothing was asked...
    expect(q.calls).toHaveLength(0)
    // ...so nothing may be claimed. These three fields all used to describe a gateway
    // confirmation that never happened.
    expect(meta(audits).evidence_basis).toBe('no_attempt_recorded')
    expect(meta(audits).charge_status_known).toBe(false)
    expect(meta(audits).finaticVerifiedBeforeCancel).toBe(false)
    expect(String(meta(audits).verification_method)).toMatch(/^NONE/)
    expect(String(meta(audits).verification_method)).toContain('no merchant order number')
  })

  test('a verified decline still records gateway_verified and a known charge status', async () => {
    const { client, audits } = makeSupabase()
    const q = answer({ paid: false, statusRecognised: true })

    await handleTerminalPaymentFailed(client, baseParams(), { queryFinaticOrderPaidFn: q.fn })

    expect(meta(audits).evidence_basis).toBe('gateway_verified')
    expect(meta(audits).charge_status_known).toBe(true)
    expect(meta(audits).finaticVerifiedBeforeCancel).toBe(true)
  })

  test('every basis written is a member of the declared vocabulary', async () => {
    for (const params of [
      baseParams({ paycloudMerchantOrderNo: null }),
      baseParams(),
      baseParams({ cancellationReason: TERMINAL_USER_CANCELLED_REASON, noGatewayAttempt: true }),
    ]) {
      const { client, audits } = makeSupabase()
      await handleTerminalPaymentFailed(client, params, {
        queryFinaticOrderPaidFn: answer({ paid: false }).fn,
      })
      expect(CANCEL_EVIDENCE_BASES).toContain(meta(audits).evidence_basis)
    }
  })
})

// ── D-4: the gateway code reaches the audit trail, and changes nothing ───────

describe('D-4 — the raw gateway result is recorded, and is inert', () => {
  test('N002 reaches the cancellation audit row', async () => {
    const { client, audits } = makeSupabase()

    await handleTerminalPaymentFailed(
      client,
      baseParams({ gatewayResult: 'N002' }),
      { queryFinaticOrderPaidFn: answer({ paid: false }).fn },
    )

    expect(meta(audits).gatewayResult).toBe('N002')
  })

  test('it reaches the unrecognised-status audit row too', async () => {
    const { client, audits } = makeSupabase()

    await handleTerminalPaymentFailed(
      client,
      baseParams({ gatewayResult: 'N002' }),
      { queryFinaticOrderPaidFn: answer({ paid: false, statusRecognised: false, status: '3' }).fn },
    )

    expect(lastAudit(audits).action).toBe(VERIFICATION_SKIPPED_ACTION)
    expect(meta(audits).gatewayResult).toBe('N002')
  })

  test('an OLDER TERMINAL that sends nothing records null, and behaves identically', async () => {
    const { client: c1, audits: a1 } = makeSupabase()
    const withCode = await handleTerminalPaymentFailed(
      c1,
      baseParams({ gatewayResult: 'N002' }),
      { queryFinaticOrderPaidFn: answer({ paid: false }).fn },
    )

    const { client: c2, audits: a2 } = makeSupabase()
    const without = await handleTerminalPaymentFailed(c2, baseParams(), {
      queryFinaticOrderPaidFn: answer({ paid: false }).fn,
    })

    // Absent means "not reported", never "none" — and the OUTCOME is the same either way.
    expect(meta(a2).gatewayResult).toBeNull()
    expect(without.outcome).toBe(withCode.outcome)
  })

  test('the code CANNOT buy a verification bypass', async () => {
    // The one property that matters. K026 is the operator-abort code, and naming it here must not
    // reproduce the noGatewayAttempt bypass by the back door: Finatic is still queried.
    const { client, audits } = makeSupabase()
    const q = answer({ paid: false })

    const res = await handleTerminalPaymentFailed(
      client,
      baseParams({ gatewayResult: 'K026' }),
      { queryFinaticOrderPaidFn: q.fn },
    )

    expect(q.calls).toHaveLength(1)
    expect(res.outcome).toBe('cancelled')
    expect(meta(audits).evidence_basis).toBe('gateway_verified')
  })
})
