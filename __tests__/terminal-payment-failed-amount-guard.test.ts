/**
 * #180 — the false-failure correction path must not write an unchecked gateway amount.
 *
 * handle-terminal-payment-failed.ts:176 reached markOrderPaidConfirmed with
 * `amount: finatic.amount ?? params.orderTotal` and no comparison of any kind, while
 * verify-payment/route.ts:117 checks the same class of value before applying it. Two routes
 * asking Finatic the same question, one of them guarded.
 *
 * WHAT THE GUARD DOES WHEN IT FAILS, and why:
 *
 * Not cancel. Finatic has just said the customer WAS charged; cancelling on a disagreement
 * about the figure is the precise failure this whole path exists to prevent.
 *
 * Not "correct to paid using the server total instead". If the reference has correlated to a
 * different sale, that marks THIS order paid on somebody else's money — the worst available
 * outcome, and it would be invisible because the row would look ordinary.
 *
 * It returns the existing `left_pending_finatic_uncertain` outcome: no cancel, no invented
 * figure, the order stays claimable, and a payment.verification_uncertain audit row makes it
 * visible. A materially different gateway amount means this order's money state is genuinely
 * not established — partial capture, a tip added at the reader, or a mis-correlated reference
 * are all live possibilities — which is exactly what that outcome already models. Both callers
 * already handle it (payment/route.ts:202), so no route or type change is needed.
 *
 * WHAT #190 CHANGED HERE, and why two assertions in this file were REVERSED rather than kept:
 *
 * This file asserted that one cent must still correct ("or the guard reintroduces #180 on this
 * path") and that an omitted amount corrects using the order total ("a missing figure is not a
 * disagreeing figure"). Both were wrong about this particular site, and #190 ruled them out:
 *
 *   ONE CENT. #180's tolerance is right for a CLIENT leg — a device-submitted figure validated
 *   against the server's total, where the two can genuinely land a cent apart. This is not that.
 *   Finatic echoes back OUR OWN figure: push-to-terminal sends Number(order.total) as
 *   order_amount and this compares against orderTotal. No arithmetic happens in between, so a
 *   cent cannot be a rounding artefact — it means the reference correlated to a different sale,
 *   the one case that must never be written through. Exact agreement, zero cents.
 *
 *   OMITTED AMOUNT. If the gateway did not give us an amount, we did not verify the amount.
 *   Applying the payment while recording "never checked" is the same shape as the unguarded
 *   write this guard exists to close, and the record could not afterwards tell the two apart.
 *
 * The one-cent case is therefore now the two-cent case's twin, and the null case refuses.
 * The #180 client tolerance is still pinned, on the sites it belongs to, by
 * __tests__/terminal-payment-cent-tolerance-routes.test.ts.
 */
// `@/payments/paycloud` is untransformed ESM and is only reachable via the real Finatic path,
// which every test here injects around.
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: jest.fn(async () => {
    throw new Error('queryPaymentOrder must not be reached — tests inject queryFinaticOrderPaidFn')
  }),
}))

const markOrderPaidConfirmed = jest.fn(async (..._args: unknown[]) => ({
  claimed: true,
  tabId: null as string | null,
}))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

import { handleTerminalPaymentFailed } from '@/lib/payments/handle-terminal-payment-failed'

const MERCHANT_ORDER_NO = 'FT17860156979870443'
const ORDER_TOTAL = 78.35

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
      const builder: Record<string, unknown> = {
        update(patch: Row) {
          updates.push(patch)
          return builder
        },
        eq: () => builder,
        in: () => builder,
        select: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: 'order-1', status: 'cancelled', payment_status: 'cancelled' },
            error: null,
          }),
        single: () => Promise.resolve({ data: { id: 'order-1' }, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [{ id: 'order-1' }], error: null })),
      }
      return builder
    },
  }
  return { client: client as never, audits, updates }
}

/** Finatic says paid, for `amount`. The seam avoids the real gateway entirely. */
function finaticPaidAt(amount: number | null) {
  return async () => ({
    paid: true,
    merchantOrderNo: MERCHANT_ORDER_NO,
    status: 'paid',
    transactionId: 'TXN-1',
    amount,
    raw: {},
  })
}

function run(amount: number | null, supabase: ReturnType<typeof makeSupabase>) {
  return handleTerminalPaymentFailed(
    supabase.client,
    {
      orderId: 'order-1',
      restaurantId: 'rest-1',
      paycloudMerchantOrderNo: MERCHANT_ORDER_NO,
      orderTotal: ORDER_TOTAL,
      amount: ORDER_TOTAL,
      reference: 'UNCONFIRMED-x',
    },
    { queryFinaticOrderPaidFn: finaticPaidAt(amount) as never },
  )
}

beforeEach(() => {
  markOrderPaidConfirmed.mockClear()
})

describe('handleTerminalPaymentFailed — Finatic amount guard on the correction path', () => {
  it('corrects to paid when Finatic echoes the order total exactly', async () => {
    const supabase = makeSupabase()
    const result = await run(ORDER_TOTAL, supabase)

    expect(result.outcome).toBe('corrected_to_paid')
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
    // The figure written is the gateway's own, now that it is known to agree exactly.
    const params = (markOrderPaidConfirmed.mock.calls[0] as unknown[])[1] as Row
    expect(params.amount).toBe(ORDER_TOTAL)
  })

  it('leaves the order pending when Finatic is one cent off (#190 — reversed)', async () => {
    // Was asserted as 'corrected_to_paid' before #190. See the header.
    const supabase = makeSupabase()
    const result = await run(78.36, supabase)

    expect(result.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(supabase.updates).toHaveLength(0)
  })

  it('leaves the order pending when Finatic omits the amount (#190 — reversed)', async () => {
    // Was asserted as 'corrected_to_paid' using the order total before #190. An absent amount
    // is unverified, not agreed, so nothing is written and nothing is cancelled.
    const supabase = makeSupabase()
    const result = await run(null, supabase)

    expect(result.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(supabase.updates).toHaveLength(0)

    const audit = supabase.audits.find((a) => a.action === 'payment.verification_uncertain')
    expect((audit?.metadata as Row)?.finaticAmount).toBeNull()
  })

  it('leaves the order pending — not cancelled — when Finatic is two cents off', async () => {
    const supabase = makeSupabase()
    const result = await run(78.37, supabase)

    expect(result.outcome).toBe('left_pending_finatic_uncertain')

    // The three things that must NOT happen on a disagreement.
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(supabase.updates).toHaveLength(0)
    expect(
      supabase.audits.some((a) => String(a.action).includes('payment.failed')),
    ).toBe(false)
  })

  it('records the disagreement in the audit trail with both figures', async () => {
    const supabase = makeSupabase()
    await run(78.37, supabase)

    const audit = supabase.audits.find((a) => a.action === 'payment.verification_uncertain')
    expect(audit).toBeDefined()
    const metadata = audit?.metadata as Row
    expect({
      finaticAmount: metadata.finaticAmount,
      expectedAmount: metadata.expectedAmount,
      outcome: metadata.outcome,
    }).toEqual({
      finaticAmount: 78.37,
      expectedAmount: ORDER_TOTAL,
      outcome: 'left_pending_finatic_uncertain',
    })
  })

  it('does not cancel an order the customer was charged for', async () => {
    // The status quo wrote the gateway figure through unchecked; the failure mode this guard
    // must never introduce is the opposite one — cancelling on a mismatch.
    const supabase = makeSupabase()
    const result = await run(120.0, supabase)

    expect(result.outcome).not.toBe('cancelled')
    expect(supabase.updates).toHaveLength(0)
  })
})
