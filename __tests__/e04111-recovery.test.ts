/**
 * PR1 — recovery path fix.
 *
 * Regression cover for a bug that exists independently of any auto-cancel rule: a webhook
 * can verify a real payment against Finatic and have it silently discarded with a 200 ACK,
 * because markOrderPaidConfirmed's claim UPDATE is gated on CLAIMABLE_PAYMENT_STATUSES
 * (['unpaid','pending']) and a cancelled order matches none of them. The claim returns
 * claimed:false, the caller discarded that result, and Finatic was told "success".
 */
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  claimableStatusesForRecovery,
  isCancelledOnE04111Evidence,
  AUTO_CANCELLED_E04111_REASON_PREFIX,
  NO_PAYMENT_ATTEMPT_REASON,
} from '@/lib/payments/e04111-recovery'
import {
  isFinaticMerchantOrderInvalidError,
  finaticErrorCode,
} from '@/lib/payments/query-finatic-order-paid'

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

// paycloud.js is ESM and jest cannot parse it; query-finatic-order-paid imports it.
// Mocked so the real classifiers in that module can be exercised.
jest.mock('@/payments/paycloud', () => ({ queryPaymentOrder: jest.fn() }))

type Row = Record<string, unknown>

/** Minimal PostgREST-shaped fake over an in-memory orders array. */
function makeSupabase(orders: Row[]) {
  const auditLogs: Row[] = []

  const client = {
    auditLogs,
    orders,
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            auditLogs.push(row)
            return { error: null }
          },
        }
      }
      if (table === 'tabs') {
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      }
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)

      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null

      const run = () => {
        const matched = orders.filter((r) => filters.every((f) => f(r)))
        if (patch) for (const r of matched) Object.assign(r, patch)
        return matched
      }

      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Row) => {
          patch = p
          return builder
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') === String(val))
          return builder
        },
        neq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') !== String(val))
          return builder
        },
        in: (col: string, vals: unknown[]) => {
          const set = vals.map(String)
          filters.push((r) => set.includes(String(r[col] ?? '')))
          return builder
        },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(resolve),
      }
      return builder
    },
  }
  return client
}

const AUTO_CANCELLED_REASON = 'auto_cancelled_e04111_persistent'

function autoCancelledOrder(): Row {
  return {
    id: 'ord-cancelled',
    restaurant_id: 'rest-1',
    total: 42.5,
    payment_method: 'card',
    status: 'cancelled',
    payment_status: 'cancelled',
    cancelled_at: '2026-08-03T10:00:00.000Z',
    cancellation_reason: AUTO_CANCELLED_REASON,
    paycloud_merchant_order_no: 'FT17857583233613303',
    tab_id: null,
  }
}

describe('isFinaticMerchantOrderInvalidError / finaticErrorCode classifier', () => {
  test('reads the structural gateway code off a thrown PaycloudRequestError', () => {
    const err = Object.assign(
      new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'),
      { responseBody: { code: 'E04111', msg: '[E04111]Merchant order number is invalid' }, phase: 'business' },
    )
    expect(finaticErrorCode(err)).toBe('E04111')
    expect(isFinaticMerchantOrderInvalidError(err)).toBe(true)
  })

  test('falls back to the message when responseBody is absent', () => {
    expect(isFinaticMerchantOrderInvalidError(new Error('PayCloud query failed: E04111 not found'))).toBe(true)
  })

  test('does NOT classify unrelated gateway failures or transport errors as E04111', () => {
    expect(isFinaticMerchantOrderInvalidError(new Error('PayCloud service unavailable: gateway timeout'))).toBe(false)
    expect(
      isFinaticMerchantOrderInvalidError(
        Object.assign(new Error('PayCloud query failed: E04002 bad sign'), {
          responseBody: { code: 'E04002' },
        }),
      ),
    ).toBe(false)
    expect(isFinaticMerchantOrderInvalidError(null)).toBe(false)
  })
})

describe('claimableStatusesForRecovery scoping', () => {
  test('widens to include cancelled for auto_cancelled_e04111* orders', () => {
    const row = { payment_status: 'cancelled', cancellation_reason: AUTO_CANCELLED_REASON }
    expect(isCancelledOnE04111Evidence(row)).toBe(true)
    expect(claimableStatusesForRecovery(row)).toContain('cancelled')
    expect(AUTO_CANCELLED_REASON.startsWith(AUTO_CANCELLED_E04111_REASON_PREFIX)).toBe(true)
  })

  test('ALSO widens for no_payment_attempt_made — staging\'s rule cancels on E04111 too', () => {
    const row = { payment_status: 'cancelled', cancellation_reason: NO_PAYMENT_ATTEMPT_REASON }
    expect(isCancelledOnE04111Evidence(row)).toBe(true)
    expect(claimableStatusesForRecovery(row)).toContain('cancelled')
  })

  test('does NOT widen for auto_timeout, hosted_timeout, or staff cancellations', () => {
    for (const reason of ['auto_timeout', 'hosted_timeout', 'terminal_cancelled']) {
      const row = { payment_status: 'cancelled', cancellation_reason: reason }
      expect(isCancelledOnE04111Evidence(row)).toBe(false)
      expect(claimableStatusesForRecovery(row)).not.toContain('cancelled')
    }
  })

  test('NULL is unrecoverable — the absence of a reason, not an unclassified one', () => {
    // RULED 2026-08-24. The inversion fails toward recovery for a reason STRING nobody has
    // classified. A NULL reason is a different thing: no rule recorded why the order died, so
    // there is nothing to weigh.
    //
    // This case used to sit inside the denylist loop above, where it passed for the WRONG reason:
    // String(null ?? '') is '' and ''.startsWith(anything) is false, so the denylist matched
    // nothing and the inverted predicate returned `recoverable`. The old test asserted `false`
    // and failed. Both the assertion and the behaviour are now deliberate rather than inherited
    // from an expression.
    for (const reason of [null, undefined, '', '   ']) {
      const row = { payment_status: 'cancelled', cancellation_reason: reason }
      expect(isCancelledOnE04111Evidence(row)).toBe(false)
      expect(claimableStatusesForRecovery(row)).not.toContain('cancelled')
    }
  })

  test('an unclassified reason STRING is still recoverable — the inversion is intact', () => {
    // The counterpart, and the reason the NULL branch had to be written narrowly. If this ever
    // flips, the 2026-08-22 fix has been undone and the 27 orders it rescued are stranded again.
    const row = {
      payment_status: 'cancelled',
      cancellation_reason: 'operator_ruling_finatic_confirmed_unpaid_20260821',
    }
    expect(isCancelledOnE04111Evidence(row)).toBe(true)
    expect(claimableStatusesForRecovery(row)).toContain('cancelled')
  })

  test('does not widen for a pending order that merely carries a stale reason string', () => {
    expect(
      isCancelledOnE04111Evidence({ payment_status: 'pending', cancellation_reason: AUTO_CANCELLED_REASON }),
    ).toBe(false)
  })
})

describe('a cancelled order with a real payment IS recovered', () => {
  test.each([
    ['auto_cancelled_e04111_persistent (PR2 rule)', AUTO_CANCELLED_REASON],
    ['no_payment_attempt_made (staging rule)', NO_PAYMENT_ATTEMPT_REASON],
  ])('recovers an order cancelled as %s', async (_label, reason) => {
    const order: Row = { ...autoCancelledOrder(), cancellation_reason: reason }
    const supabase = makeSupabase([order])

    const result = await markOrderPaidConfirmed(supabase as never, {
      orderId: 'ord-cancelled',
      restaurantId: 'rest-1',
      reference: 'FT17857583233613303',
      amount: 42.5,
      source: 'paycloud_webhook_fallback_finatic_verified',
      fromPaymentStatuses: claimableStatusesForRecovery(order),
    })

    expect(result.claimed).toBe(true)
    expect(order.payment_status).toBe('paid')
    expect(order.cancellation_reason).toBeNull()
    expect(order.cancelled_at).toBeNull()
  })

  test('claims the order and CLEARS cancelled_at + cancellation_reason', async () => {
    const order = autoCancelledOrder()
    const supabase = makeSupabase([order])

    const result = await markOrderPaidConfirmed(supabase as never, {
      orderId: 'ord-cancelled',
      restaurantId: 'rest-1',
      reference: 'FT17857583233613303',
      amount: 42.5,
      source: 'paycloud_webhook_fallback_finatic_verified',
      fromPaymentStatuses: claimableStatusesForRecovery(order),
    })

    console.log('RECOVERY_RESULT', JSON.stringify({ result, order }, null, 2))

    expect(result.claimed).toBe(true)
    expect(order.payment_status).toBe('paid')
    expect(order.status).toBe('completed')
    // The whole point: no contradictory completed+paid+cancellation_reason row.
    expect(order.cancellation_reason).toBeNull()
    expect(order.cancelled_at).toBeNull()
    // Evidence is preserved, never destroyed by the recovery.
    expect(order.paycloud_merchant_order_no).toBe('FT17857583233613303')
    expect(supabase.auditLogs.some((a) => a.action === 'payment.completed')).toBe(true)
  })

  test('WITHOUT the widened statuses the same payment is silently discarded (the bug)', async () => {
    const order = autoCancelledOrder()
    const supabase = makeSupabase([order])

    // Default CLAIMABLE_PAYMENT_STATUSES — what every caller used before this change.
    const result = await markOrderPaidConfirmed(supabase as never, {
      orderId: 'ord-cancelled',
      restaurantId: 'rest-1',
      reference: 'FT17857583233613303',
      amount: 42.5,
      source: 'paycloud_webhook_fallback_finatic_verified',
    })

    console.log('PRE_FIX_BEHAVIOUR', JSON.stringify(result, null, 2))
    expect(result).toEqual({ claimed: false, reason: 'claim_conflict' })
    expect(order.payment_status).toBe('cancelled')
  })

  test('an already-paid order yields already_paid, not claim_conflict', async () => {
    const order = { ...autoCancelledOrder(), payment_status: 'paid', status: 'completed' }
    const supabase = makeSupabase([order])

    const result = await markOrderPaidConfirmed(supabase as never, {
      orderId: 'ord-cancelled',
      restaurantId: 'rest-1',
      reference: 'FT1',
      amount: 42.5,
      source: 'test',
      fromPaymentStatuses: claimableStatusesForRecovery(order),
    })

    expect(result).toEqual({ claimed: false, reason: 'already_paid' })
  })
})
