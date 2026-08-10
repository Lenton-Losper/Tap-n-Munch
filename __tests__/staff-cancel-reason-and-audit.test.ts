/**
 * Issue #103. PATCH /api/orders/[orderId]/status is the generic staff/kitchen status route
 * and the third path in the codebase that cancels an order. The other two --
 * handleTerminalPaymentFailed and autoCancelStalePosOrders -- always write a real
 * cancellation_reason and an audit_logs row. This one wrote status, cancelled_at, is_closed
 * and payment_status='cancelled' and nothing else, so a staff cancel left
 * `cancellation_reason: null` and zero audit rows: order #55 took process-of-elimination
 * across every cancel-writing path to explain.
 *
 * Additive only. What the route does to order state -- the status claim, the timestamp
 * fields, is_closed, payment_status -- must be unchanged.
 */
import { PATCH } from '@/app/api/orders/[orderId]/status/route'

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (value: unknown) => value instanceof Response,
  requireStaffPermission: async () => ({ userId: 'staff-7', restaurantId: 'rest-1' }),
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

type UpdateCall = { patch: Record<string, unknown>; filters: Array<[string, unknown]> }

let existingOrder: Record<string, unknown> | null
let updateCalls: UpdateCall[]
let auditRows: Record<string, unknown>[]
/** null models a lost status claim (the row moved on) -- the route's 409. */
let updateResult: Record<string, unknown> | null

function makeSupabaseMock() {
  return {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            auditRows.push(row)
            return { error: null }
          },
        }
      }
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: existingOrder, error: null }) }),
        }),
        update: (patch: Record<string, unknown>) => {
          const call: UpdateCall = { patch, filters: [] }
          updateCalls.push(call)
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              call.filters.push([column, value])
              return builder
            },
            select() {
              return {
                maybeSingle: async () => ({ data: updateResult, error: null }),
              }
            },
          }
          return builder
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

function patchRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/orders/order-1/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function callPatch(body: Record<string, unknown>) {
  const response = await PATCH(patchRequest(body), { params: Promise.resolve({ orderId: 'order-1' }) })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  existingOrder = { id: 'order-1', restaurant_id: 'rest-1', status: 'preparing' }
  updateCalls = []
  auditRows = []
  updateResult = {
    id: 'order-1',
    status: 'cancelled',
    payment_status: 'cancelled',
    is_closed: true,
    cancelled_at: '2026-08-08T10:00:00Z',
    paid_at: null,
  }
})

describe('staff cancel records why (#103)', () => {
  it('writes a cancellation_reason even when the caller sends none', async () => {
    const { status } = await callPatch({ status: 'cancelled' })

    expect(status).toBe(200)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].patch.cancellation_reason).toBe('staff_cancelled')
  })

  it('uses the reason the caller gave, under any of the three spellings the terminal route accepts', async () => {
    await callPatch({ status: 'cancelled', cancellation_reason: '  kitchen out of stock  ' })
    expect(updateCalls[0].patch.cancellation_reason).toBe('kitchen out of stock')

    updateCalls = []
    await callPatch({ status: 'cancelled', cancellationReason: 'customer left' })
    expect(updateCalls[0].patch.cancellation_reason).toBe('customer left')

    updateCalls = []
    await callPatch({ status: 'cancelled', reason: 'duplicate order' })
    expect(updateCalls[0].patch.cancellation_reason).toBe('duplicate order')
  })

  it('writes one audit_logs row naming the staff member, the reason and the previous status', async () => {
    await callPatch({ status: 'cancelled', reason: 'customer left' })

    expect(auditRows).toHaveLength(1)
    const row = auditRows[0]
    expect(row.restaurant_id).toBe('rest-1')
    expect(row.action).toBe('order.cancelled')
    expect(row.entity_type).toBe('order')
    expect(row.entity_id).toBe('order-1')
    expect(row.metadata).toMatchObject({
      cancellation_reason: 'customer left',
      previous_status: 'preparing',
      staff_user_id: 'staff-7',
      source: 'orders/status',
    })
  })

  it('leaves the order-state writes exactly as they were', async () => {
    await callPatch({ status: 'cancelled' })

    const { patch, filters } = updateCalls[0]
    expect(patch.status).toBe('cancelled')
    expect(patch.is_closed).toBe(true)
    expect(patch.payment_status).toBe('cancelled')
    expect(typeof patch.cancelled_at).toBe('string')
    // The conditional claim on the status we read is what makes Accept-vs-Cancel safe.
    expect(filters).toContainEqual(['status', 'preparing'])
  })
})

describe('what must NOT get a reason or an audit row (#103)', () => {
  it('says nothing about cancellation on an ordinary status change', async () => {
    updateResult = { id: 'order-1', status: 'ready', payment_status: 'pending', is_closed: false }
    const { status } = await callPatch({ status: 'ready' })

    expect(status).toBe(200)
    expect(updateCalls[0].patch).not.toHaveProperty('cancellation_reason')
    expect(auditRows).toHaveLength(0)
  })

  it('writes no audit row when the status claim is lost (409)', async () => {
    updateResult = null
    const { status } = await callPatch({ status: 'cancelled' })

    expect(status).toBe(409)
    expect(auditRows).toHaveLength(0)
  })

  it('writes no audit row for a payment_status-only patch', async () => {
    updateResult = { id: 'order-1', status: 'preparing', payment_status: 'paid', paid_at: 'x' }
    await callPatch({ payment_status: 'paid' })

    expect(updateCalls[0].patch).not.toHaveProperty('cancellation_reason')
    expect(auditRows).toHaveLength(0)
  })
})
