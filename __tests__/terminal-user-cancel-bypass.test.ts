/**
 * The terminal user-cancel fast path, and — more importantly — proof that it does NOT swallow
 * anything else.
 *
 * A user cancel on WiseCashier never reaches the gateway, so Finatic has no payment order and
 * returns E04111. The old code treated that as "uncertain" and left the order pending forever,
 * which is the entire stranding class.
 *
 * The bypass is the risky half of this change. If it ever fires on a genuine decline, or on an
 * ambiguous outcome, we would be cancelling orders the customer may actually have been charged
 * for — far worse than the problem being fixed. Most of this file exists to pin that down.
 */
// `@/payments/paycloud` is untransformed ESM and is only reachable via the real Finatic path,
// which every test here either injects around or asserts is never called.
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: jest.fn(async () => {
    throw new Error('queryPaymentOrder must not be reached — tests inject queryFinaticOrderPaidFn')
  }),
}))

import {
  handleTerminalPaymentFailed,
  TERMINAL_USER_CANCELLED_REASON,
} from '@/lib/payments/handle-terminal-payment-failed'

const MERCHANT_ORDER_NO = 'FT17860156979870443'

type Row = Record<string, unknown>

function makeSupabase() {
  const audits: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      if (table === 'audit_logs') {
        return { insert: (row: Row) => { audits.push(row); return Promise.resolve({ error: null }) } }
      }
      if (table === 'orders') {
        const builder: Record<string, unknown> = {
          update(patch: Row) { updates.push(patch); return builder },
          eq() { return builder },
          in() { return builder },
          select() { return builder },
          maybeSingle() {
            return Promise.resolve({ data: { id: 'order-1', status: 'cancelled', payment_status: 'cancelled' }, error: null })
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
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    },
  }
  return { client: client as never, audits, updates }
}

function baseParams(over: Row = {}) {
  return {
    orderId: 'order-1',
    restaurantId: 'rest-1',
    paycloudMerchantOrderNo: MERCHANT_ORDER_NO,
    orderTotal: 40,
    amount: 40,
    reference: 'UNCONFIRMED-x',
    ...over,
  } as never
}

/** Stands in for Finatic. Records whether it was called at all. */
function makeQuery(result: { paid: boolean } | Error) {
  const calls: unknown[] = []
  const fn = async (args: unknown) => {
    calls.push(args)
    if (result instanceof Error) throw result
    return result as never
  }
  return { fn, calls }
}

describe('terminal user-cancel bypass', () => {
  test('a user cancel cancels immediately and NEVER calls Finatic', async () => {
    const { client, audits } = makeSupabase()
    const q = makeQuery(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'))

    const res = await handleTerminalPaymentFailed(client, baseParams({
      cancellationReason: TERMINAL_USER_CANCELLED_REASON,
      noGatewayAttempt: true,
      auditAction: 'payment.cancelled_terminal_cancelled_pre_gateway',
    }), { queryFinaticOrderPaidFn: q.fn as never })

    expect(res.outcome).toBe('cancelled')
    expect(q.calls).toHaveLength(0) // the whole point — no gateway round trip
    const audit = audits.at(-1)!
    const md = audit.metadata as Row
    expect(md.evidence_basis).toBe('terminal_asserted')
    expect(md.finaticVerifiedBeforeCancel).toBe(false)
    expect(String(md.verification_method)).toMatch(/^NONE/)
  })

  test('REGRESSION GUARD: a genuine decline still goes through verification and is NOT fast-cancelled', async () => {
    // If this ever fails, real declines are being cancelled without checking whether the
    // customer was charged. This is the failure mode that matters most.
    const { client, audits } = makeSupabase()
    const q = makeQuery({ paid: false })

    const res = await handleTerminalPaymentFailed(client, baseParams({
      cancellationReason: 'payment_declined',
      // Note: NOT setting noGatewayAttempt. A decline did reach the gateway.
    }), { queryFinaticOrderPaidFn: q.fn as never })

    expect(q.calls).toHaveLength(1) // verification happened
    expect(res.outcome).toBe('cancelled')
    const md = audits.at(-1)!.metadata as Row
    expect(md.evidence_basis).toBe('gateway_verified')
    expect(md.finaticVerifiedBeforeCancel).toBe(true)
  })

  test('an ambiguous outcome that is neither still leaves the order PENDING', async () => {
    const { client, audits } = makeSupabase()
    const q = makeQuery(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'))

    const res = await handleTerminalPaymentFailed(client, baseParams({
      cancellationReason: 'terminal_cancelled',
    }), { queryFinaticOrderPaidFn: q.fn as never })

    expect(q.calls).toHaveLength(1)
    expect(res.outcome).toBe('left_pending_finatic_uncertain')
    expect(audits.some((a) => a.action === 'payment.verification_uncertain')).toBe(true)
  })

  describe('the bypass fires ONLY on the exact reason, nothing adjacent', () => {
    const adjacent = [
      'terminal_cancelled',
      'terminal_cancelled_by_user',
      'TERMINAL_CANCELLED_BY_USER_PRE_GATEWAY',    // case differs — a different string
      'terminal_cancelled_by_user_pre_gateway_v2', // suffix — a different reason
      'terminal_cancelled_by_user_pre_gatewa',     // truncated
      'pre_gateway',
      'payment_declined',
      '',
    ]

    test.each(adjacent)('reason %p does NOT bypass verification', async (reason) => {
      const { client } = makeSupabase()
      const q = makeQuery({ paid: false })
      await handleTerminalPaymentFailed(client, baseParams({
        cancellationReason: reason,
        noGatewayAttempt: true, // even WITH the flag set, a non-exact reason must not bypass
      }), { queryFinaticOrderPaidFn: q.fn as never })
      expect(q.calls).toHaveLength(1)
    })

    test.each([
      'terminal_cancelled_by_user_pre_gateway ',
      ' terminal_cancelled_by_user_pre_gateway',
      '  terminal_cancelled_by_user_pre_gateway  ',
    ])('surrounding whitespace %p DOES still bypass — this is deliberate', async (reason) => {
      // handleTerminalPaymentFailed trims cancellationReason before comparing (line ~84).
      // Whitespace padding is not an ADJACENT reason, it is the SAME reason with stray
      // characters, so normalising it is correct input hygiene rather than a loophole.
      // Asserted explicitly so nobody "tightens" the comparison and breaks a real caller.
      const { client } = makeSupabase()
      const q = makeQuery({ paid: false })
      await handleTerminalPaymentFailed(client, baseParams({
        cancellationReason: reason,
        noGatewayAttempt: true,
      }), { queryFinaticOrderPaidFn: q.fn as never })
      expect(q.calls).toHaveLength(0)
    })

    test('CONTROL: the exact reason DOES bypass — otherwise the cases above prove nothing', async () => {
      const { client } = makeSupabase()
      const q = makeQuery({ paid: false })
      await handleTerminalPaymentFailed(client, baseParams({
        cancellationReason: TERMINAL_USER_CANCELLED_REASON,
        noGatewayAttempt: true,
      }), { queryFinaticOrderPaidFn: q.fn as never })
      expect(q.calls).toHaveLength(0)
    })

    test('the exact reason WITHOUT the flag does not bypass either — both are required', async () => {
      const { client } = makeSupabase()
      const q = makeQuery({ paid: false })
      await handleTerminalPaymentFailed(client, baseParams({
        cancellationReason: TERMINAL_USER_CANCELLED_REASON,
        // noGatewayAttempt deliberately omitted
      }), { queryFinaticOrderPaidFn: q.fn as never })
      expect(q.calls).toHaveLength(1)
    })
  })

  test('a user cancel that somehow IS paid at the gateway is impossible to reach — but if the flag is wrong, the decline path still protects us', async () => {
    // Defence in depth: with the flag unset (the safe default), a reference that IS paid gets
    // picked up by verification rather than cancelled.
    const { client } = makeSupabase()
    const q = makeQuery({ paid: true })
    const res = await handleTerminalPaymentFailed(client, baseParams({
      cancellationReason: 'payment_declined',
    }), { queryFinaticOrderPaidFn: q.fn as never })
    expect(q.calls).toHaveLength(1)
    expect(res.outcome).not.toBe('cancelled')
  })
})
