import { NextRequest } from 'next/server'
import { ORDER_CANCELLED_ACTION } from '@/lib/orders/cancel-order-with-trail'

/**
 * THE TERMINAL'S PRE-GATEWAY CANCEL LEAVES A TRAIL.
 *
 * This branch is taken when the order carries no paycloud_merchant_order_no — nothing was ever sent
 * to the gateway, so cancelling is safe and no Finatic call is made. Until 2026-08-22 it wrote all
 * four order columns and NO audit row, which is why Riviera #7 (cancelled 2026-08-18) is the single
 * untracked `terminal_cancelled` cancellation on production.
 *
 * BOTH DIRECTIONS ARE ASSERTED, because the two ways to get this wrong pull opposite:
 *   - write the row but stop cancelling  -> the operator cannot abandon a sale
 *   - write the row from the GATEWAY branch too -> a cancellation logged for an order that
 *     handleTerminalPaymentFailed is separately deciding about, i.e. a double trail
 *
 * The suite drives the REAL exported PATCH handler over a real Request. Calling the helper directly
 * would pass even if the route never called it — which is exactly how this branch shipped without
 * an audit row in the first place.
 */
const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const TERMINAL_ID = 'c103a8bd-759a-4a61-bc79-5043adae50c7'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

type Row = Record<string, unknown>

const handleTerminalPaymentFailed = jest.fn(async () => ({ outcome: 'cancelled' as const, tabId: null }))

jest.mock('@/lib/payments/handle-terminal-payment-failed', () => ({
  handleTerminalPaymentFailed: (...args: unknown[]) =>
    (handleTerminalPaymentFailed as unknown as (...a: unknown[]) => unknown)(...args),
  TERMINAL_USER_CANCELLED_REASON: 'terminal_cancelled_by_user_pre_gateway',
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: TERMINAL_ID,
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))

/** Mutable across tests so one double serves every scenario. */
const state: {
  order: Row
  updateReturns: Row[] | null
  auditInsertFails: boolean
  inserted: Row[]
  updates: Row[]
} = { order: {}, updateReturns: null, auditInsertFails: false, inserted: [], updates: [] }

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const st = { didUpdate: false }
      const b: Record<string, unknown> = {}
      const self = () => b
      b.select = () => self()
      b.eq = () => self()
      b.neq = () => self()
      b.in = () => self()
      b.is = () => self()
      b.order = () => self()
      b.limit = () => self()
      b.update = (patch: Row) => {
        st.didUpdate = true
        state.updates.push({ table, ...patch })
        return self()
      }
      b.insert = (row: Row | Row[]) => {
        // A failed insert writes NOTHING, so the double must not record one either -- otherwise
        // "no audit row exists" cannot be asserted for the failure case at all.
        if (table === 'audit_logs' && !state.auditInsertFails) {
          state.inserted.push(...(Array.isArray(row) ? row : [row]))
        }
        return { error: state.auditInsertFails ? { message: 'insert failed' } : null }
      }
      b.maybeSingle = async () => ({ data: state.order, error: null })
      b.single = async () => ({ data: state.order, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'orders' && st.didUpdate) {
          return Promise.resolve({ data: state.updateReturns ?? [state.order], error: null }).then(resolve)
        }
        return Promise.resolve({ data: [state.order], error: null }).then(resolve)
      }
      return b
    },
  }),
}))

const baseOrder = (over: Row = {}): Row => ({
  id: ORDER_ID,
  restaurant_id: RESTAURANT_UUID,
  total: 25,
  payment_status: 'pending',
  status: 'pending',
  payment_method: 'card',
  paycloud_merchant_order_no: null,
  tab_id: null,
  ...over,
})

async function patch(body: Row) {
  const { PATCH } = await import('@/app/api/terminal/orders/[orderId]/status/route')
  const req = new NextRequest(`http://localhost/api/terminal/orders/${ORDER_ID}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
  return PATCH(req, { params: Promise.resolve({ orderId: ORDER_ID }) } as never)
}

const cancelRows = () => state.inserted.filter((r) => r.action === ORDER_CANCELLED_ACTION)

beforeEach(() => {
  state.order = baseOrder()
  state.updateReturns = null
  state.auditInsertFails = false
  state.inserted = []
  state.updates = []
  handleTerminalPaymentFailed.mockClear()
})

describe('pre-gateway cancel — no merchant order number', () => {
  it('still cancels the order', async () => {
    const res = await patch({ status: 'cancelled' })
    const json = await res.json()
    expect(json.outcome).toBe('cancelled')
    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(true)
  })

  it('writes the audit row naming the basis', async () => {
    await patch({ status: 'cancelled' })
    const rows = cancelRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(ORDER_ID)
    expect(rows[0].restaurant_id).toBe(RESTAURANT_UUID)
    const meta = rows[0].metadata as Row
    expect(meta.basis).toBe('terminal_pre_gateway')
    expect(meta.cancellationReason).toBe('terminal_cancelled')
    expect(meta.terminalId).toBe(TERMINAL_ID)
  })

  it('records the caller-supplied reason rather than the default when one is sent', async () => {
    await patch({ status: 'cancelled', cancellationReason: 'terminal_cancelled_by_user_pre_gateway' })
    const meta = cancelRows()[0].metadata as Row
    expect(meta.cancellationReason).toBe('terminal_cancelled_by_user_pre_gateway')
  })

  it('never lets a cancellation succeed unrecorded', async () => {
    // The audit insert fails: the response must NOT be a success, or the row is cancelled and the
    // trail is lost — the exact defect being fixed.
    state.auditInsertFails = true
    const res = await patch({ status: 'cancelled' })
    expect(res.status).toBe(500)
    expect(cancelRows()).toHaveLength(0)
  })

  it('writes nothing when the update matches no row', async () => {
    state.updateReturns = []
    const res = await patch({ status: 'cancelled' })
    expect(res.status).toBe(500)
    expect(cancelRows()).toHaveLength(0)
  })
})

describe('the other branches are untouched', () => {
  it('an order WITH a merchant order number still goes to handleTerminalPaymentFailed', async () => {
    state.order = baseOrder({ paycloud_merchant_order_no: MERCHANT_ORDER_NO })
    await patch({ status: 'cancelled' })
    expect(handleTerminalPaymentFailed).toHaveBeenCalledTimes(1)
    // That handler writes its own trail; this route must not add a second one.
    expect(cancelRows()).toHaveLength(0)
  })

  it('a non-cancel status change writes no cancellation row', async () => {
    await patch({ status: 'preparing' })
    expect(cancelRows()).toHaveLength(0)
  })
})
