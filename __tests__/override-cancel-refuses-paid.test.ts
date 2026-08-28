/**
 * THE TWO-SIDED PROOF: an override cancels a held order, and REFUSES a paid one.
 *
 * The refusal is the half that matters. An override is permission to overrule a TIMING rule; it is
 * never permission to cancel an order the provider reports as paid. So this drives the real
 * `overrideCancelHeldOrder` — not a reimplementation of it — and asserts on what it actually
 * returns and writes.
 *
 * The gateway is the only thing stubbed, because the whole point is what happens when the gateway
 * changes its answer between the board rendering and the operator pressing the button. That race is
 * real and measured: order #149 at Mingle went `verification_uncertain` -> `completed` in 22
 * seconds on the same reference. An operator presses this button precisely when the order is fresh,
 * which is exactly when that race is live.
 *
 * PROOF CEILING: the gateway is a stub, so this proves the DECISION and the WRITE, not that Finatic
 * returns what we think. The staging probe alongside it covers the live half.
 */

const queryFinaticOrderPaid = jest.fn()
const isFinaticMerchantOrderInvalidError = jest.fn(() => false)

jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  queryFinaticOrderPaid: (...a: unknown[]) => queryFinaticOrderPaid(...a),
  isFinaticMerchantOrderInvalidError: (...a: unknown[]) => isFinaticMerchantOrderInvalidError(...a),
  finaticErrorCode: () => 'E04111',
}))

import { overrideCancelHeldOrder } from '@/lib/orders/override-cancel'

const ORDER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

/**
 * A held order: plain `pending`, three hours old so it is past STRANDED_PENDING_THRESHOLD_MS
 * (2h, measured), carrying a gateway reference and no card-machine marker.
 *
 * Three hours is deliberately well under the 72h the persistence rule requires -- this is exactly
 * the order the rule refuses and the override exists for.
 */
function heldRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    restaurant_id: RESTAURANT_ID,
    order_number: 41,
    status: 'pending',
    payment_status: 'pending',
    total: 147,
    placed_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    paycloud_merchant_order_no: 'FT17857583233613303',
    payment_reference: null,
    payment_voucher_no: null,
    payment_attempt_started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ...overrides,
  }
}

function fakeSupabase(row: Record<string, unknown> | null) {
  const audits: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []

  const client = {
    audits,
    updates,
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert(v: Record<string, unknown>) {
            audits.push(v)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'restaurants') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { finatic_merchant_no: 'M1', finatic_store_no: 'S1' },
                  error: null,
                }),
            }),
          }),
        }
      }
      // orders
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          }),
        }),
        update(patch: Record<string, unknown>) {
          updates.push(patch)
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: { id: ORDER_ID, order_number: 41, total: 147 },
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
        },
      }
    },
  }
  return client
}

beforeEach(() => {
  queryFinaticOrderPaid.mockReset()
  isFinaticMerchantOrderInvalidError.mockReset().mockReturnValue(false)
})

describe('THE REFUSAL — the provider says PAID', () => {
  it('refuses, does not write a cancel, and says what to do instead', async () => {
    queryFinaticOrderPaid.mockResolvedValue({
      paid: true,
      statusRecognised: true,
      merchantOrderNo: 'FT17857583233613303',
      status: 'PAID',
      transactionId: 'txn-1',
      amount: 147,
      raw: {},
    })

    const db = fakeSupabase(heldRow())
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'operator-1',
    })

    // Printed so the refusal is READ, not taken on trust.
    console.log('REFUSAL RETURNED:', JSON.stringify(result, null, 2))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal).toBe('gateway_reports_paid')
    expect(result.message).toBe(
      'The payment provider now reports this order as PAID, so it has not been cancelled. ' +
        'Refund it instead if the customer is owed money.',
    )

    // THE PART THAT MATTERS MOST: nothing was cancelled.
    expect(db.updates).toHaveLength(0)
  })

  it('audits the refusal, flagged as an operator override', async () => {
    queryFinaticOrderPaid.mockResolvedValue({
      paid: true,
      statusRecognised: true,
      merchantOrderNo: 'x',
      status: 'PAID',
      transactionId: null,
      amount: null,
      raw: {},
    })

    const db = fakeSupabase(heldRow())
    await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'operator-1',
    })

    expect(db.audits).toHaveLength(1)
    const meta = db.audits[0].metadata as Record<string, unknown>
    expect(db.audits[0].action).toBe('order_held_operator_override_refused')
    expect(meta.refusal).toBe('gateway_reports_paid')
    expect(meta.operatorOverride).toBe(true)
    expect(meta.requestedBy).toBe('operator-1')
  })
})

describe('the other refusals that never authorise a cancel', () => {
  it('an unrecognised status refuses — not-paid alone is not proof of not-paid', async () => {
    queryFinaticOrderPaid.mockResolvedValue({
      paid: false,
      statusRecognised: false,
      merchantOrderNo: 'x',
      status: 'SOMETHING_NEW',
      transactionId: null,
      amount: null,
      raw: {},
    })

    const db = fakeSupabase(heldRow())
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'op',
    })

    expect(result.ok).toBe(false)
    expect(db.updates).toHaveLength(0)
  })

  it('an unreachable gateway refuses and says the card may have been charged', async () => {
    queryFinaticOrderPaid.mockRejectedValue(new Error('socket hang up'))
    isFinaticMerchantOrderInvalidError.mockReturnValue(false)

    const db = fakeSupabase(heldRow())
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'op',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('The card may have been charged.')
    expect(db.updates).toHaveLength(0)
  })

  it('an order carrying a card-machine marker refuses without even asking the gateway', async () => {
    const db = fakeSupabase(heldRow({ payment_reference: 'VOUCHER-9' }))
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'op',
    })

    expect(result.ok).toBe(false)
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })

  it('an already-paid order never reaches the gateway at all', async () => {
    const db = fakeSupabase(heldRow({ payment_status: 'paid' }))
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'op',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal).toBe('order_not_held')
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })
})

describe('THE OTHER SIDE — E04111 on a fresh order DOES cancel', () => {
  it('cancels, and records that a human overruled the rule', async () => {
    // The gateway throws E04111: "no record of this reference". This is the case the override
    // exists for, and the one the 72h rule refuses.
    queryFinaticOrderPaid.mockRejectedValue(new Error('E04111'))
    isFinaticMerchantOrderInvalidError.mockReturnValue(true)

    const db = fakeSupabase(heldRow())
    const result = await overrideCancelHeldOrder(db as never, {
      restaurantId: RESTAURANT_ID,
      orderId: ORDER_ID,
      requestedBy: 'operator-1',
    })

    expect(result.ok).toBe(true)
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]).toMatchObject({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancellation_reason: 'operator_override_e04111',
    })

    const meta = db.audits[0].metadata as Record<string, unknown>
    expect(db.audits[0].action).toBe('order_held_operator_override_cancel')
    expect(meta.operatorOverride).toBe(true)
    expect(meta.overrodeRule).toBe('e04111_persistence_2026_08_27')
    expect(meta.requestedBy).toBe('operator-1')
    // The numbers the decision was taken on — a verdict with no numbers is unauditable.
    expect(meta.ageHours).toEqual(expect.any(Number))
    expect(meta.gatewayCode).toBe('E04111')
  })
})
