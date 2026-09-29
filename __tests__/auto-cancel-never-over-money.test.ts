/**
 * THE AUTOMATIC CANCELLERS NEVER CANCEL AN ORDER WITH MONEY ON IT.
 * (Sprint 2026-09-29, team-lead follow-up to F-MANUAL task 2.)
 *
 * The stale-POS sweep, the hosted-checkout expiry and the terminal payment-failed path cancel
 * orders that are still pending, so `payment_status = 'paid'` can never stop them. A pending order
 * can still carry money: a settled item allocation, a non-gateway ledger row, or a gateway sale
 * the device recorded while the order row never moved. Each canceller now asks
 * findOrdersWithMoney first; an unreadable payment state cancels NOTHING (fail closed).
 *
 * The REAL functions run; the database is a small double that answers each table from the case's
 * evidence and records every write.
 */
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: jest.fn(async () => {
    throw new Error('queryPaymentOrder must not be reached')
  }),
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { expireHostedPendingOrders } from '@/lib/orders/expire-hosted-pending-orders'
import {
  handleTerminalPaymentFailed,
  TERMINAL_USER_CANCELLED_REASON,
} from '@/lib/payments/handle-terminal-payment-failed'

type Row = Record<string, unknown>
const ORDER = 'order-1'
const RESTAURANT = 'rest-1'

type Evidence = 'none' | 'allocation' | 'ledger' | 'sale' | 'refunded_sale' | 'unreadable'

function makeSupabase(evidence: Evidence, candidate: Row) {
  const updates: Row[] = []
  const audits: Row[] = []
  const client = {
    from(table: string) {
      const st = { didUpdate: false, eventType: '' }
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = () => self()
      chain.insert = (rows: Row | Row[]) => {
        if (table === 'audit_logs') audits.push(...(Array.isArray(rows) ? rows : [rows]))
        return { error: null }
      }
      chain.update = (patch: Row) => {
        st.didUpdate = true
        updates.push({ table, ...patch })
        return self()
      }
      chain.eq = (col: string, val: unknown) => {
        if (col === 'event_type') st.eventType = String(val)
        return self()
      }
      for (const m of ['lt', 'in', 'is', 'neq', 'order', 'limit', 'overlaps', 'gte', 'not']) chain[m] = () => self()
      const answer = (): { data: unknown; error: unknown } => {
        if (table === 'orders') {
          if (st.didUpdate) return { data: [{ ...candidate, status: 'cancelled' }], error: null }
          return { data: [candidate], error: null }
        }
        const ledgerTables = ['order_line_allocations', 'non_gateway_payment_events', 'payment_events']
        if (ledgerTables.includes(table) && evidence === 'unreadable') {
          return { data: null, error: { message: 'ledger unreadable (test)' } }
        }
        if (table === 'order_line_allocations') {
          return { data: evidence === 'allocation' ? [{ order_id: ORDER, settled_at: '2026-09-29T09:00:00Z' }] : [], error: null }
        }
        if (table === 'non_gateway_payment_events') {
          return { data: evidence === 'ledger' ? [{ order_ids: [ORDER] }] : [], error: null }
        }
        if (table === 'payment_events') {
          const hasSale = evidence === 'sale' || evidence === 'refunded_sale'
          if (st.eventType === 'sale') {
            return { data: hasSale ? [{ business_order_no: 'FT-S', amount: 33, order_ids: [ORDER] }] : [], error: null }
          }
          return {
            data: evidence === 'refunded_sale' ? [{ origin_business_order_no: 'FT-S', amount: 33 }] : [],
            error: null,
          }
        }
        return { data: [], error: null }
      }
      chain.range = (from: number) =>
        Promise.resolve(table === 'orders' && from === 0 ? answer() : table === 'orders' ? { data: [], error: null } : answer())
      chain.maybeSingle = async () => {
        const r = answer()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      }
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve)
      return chain
    },
  }
  const cancelWrites = () => updates.filter((u) => u.table === 'orders' && u.payment_status === 'cancelled')
  // The refusal, written down (Sprint 2026-09-29): one row per order left alone over money.
  const refusals = () => audits.filter((a) => a.action === 'order.auto_cancel_refused_money_present')
  return { client: client as never, cancelWrites, refusals }
}

const posCandidate = () => ({
  id: ORDER, restaurant_id: RESTAURANT, total: 33, channel: 'pos', paycloud_merchant_order_no: null,
  payment_status: 'pending',
})
const hostedCandidate = () => ({
  id: ORDER, restaurant_id: RESTAURANT, total: 33, tab_id: null, table_number: 4, paycloud_merchant_order_no: 'FT-H',
})

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

const MONEY: Evidence[] = ['allocation', 'ledger', 'sale', 'unreadable']

describe('stale-POS sweep (autoCancelStalePosOrders)', () => {
  it('cancels a stale order with no money on it (positive control)', async () => {
    const { client, cancelWrites } = makeSupabase('none', posCandidate())
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: false })
    expect(result.cancelledIds).toContain(ORDER)
    expect(cancelWrites()).toHaveLength(1)
  })

  it.each(MONEY)('does NOT cancel when the evidence is: %s', async (evidence) => {
    const { client, cancelWrites, refusals } = makeSupabase(evidence, posCandidate())
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: false })
    expect(result.cancelledIds).not.toContain(ORDER)
    expect(cancelWrites()).toHaveLength(0)
    // Money present is written down; an unreadable state has nothing to name and is only logged.
    expect(refusals()).toHaveLength(evidence === 'unreadable' ? 0 : 1)
    if (evidence !== 'unreadable') expect(refusals()[0]).toMatchObject({ restaurant_id: RESTAURANT, entity_id: ORDER })
  })

  it('a gateway sale REFUNDED IN FULL no longer holds the order', async () => {
    const { client, cancelWrites } = makeSupabase('refunded_sale', posCandidate())
    await autoCancelStalePosOrders(client, { verifyWithFinatic: false })
    expect(cancelWrites()).toHaveLength(1)
  })
})

describe('hosted-checkout expiry (expireHostedPendingOrders)', () => {
  it('expires an abandoned checkout with no money on it (positive control)', async () => {
    const { client, cancelWrites } = makeSupabase('none', hostedCandidate())
    const result = await expireHostedPendingOrders(client)
    expect(result.expiredCount).toBe(1)
    expect(cancelWrites()).toHaveLength(1)
  })

  it.each(MONEY)('does NOT expire when the evidence is: %s', async (evidence) => {
    const { client, cancelWrites, refusals } = makeSupabase(evidence, hostedCandidate())
    const result = await expireHostedPendingOrders(client)
    expect(result.expiredCount).toBe(0)
    expect(cancelWrites()).toHaveLength(0)
    expect(refusals()).toHaveLength(evidence === 'unreadable' ? 0 : 1)
  })
})

describe('terminal payment-failed (handleTerminalPaymentFailed)', () => {
  const userCancel = () =>
    ({
      orderId: ORDER,
      restaurantId: RESTAURANT,
      paycloudMerchantOrderNo: 'FT-T',
      orderTotal: 33,
      amount: 33,
      reference: 'UNCONFIRMED-x',
      cancellationReason: TERMINAL_USER_CANCELLED_REASON,
      noGatewayAttempt: true,
    }) as never
  const noFinatic = { queryFinaticOrderPaidFn: (async () => { throw new Error('not reached') }) as never }

  it('cancels when there is no money on the order (positive control)', async () => {
    const { client, cancelWrites } = makeSupabase('none', { id: ORDER })
    const res = await handleTerminalPaymentFailed(client, userCancel(), noFinatic)
    expect(res.outcome).toBe('cancelled')
    expect(cancelWrites()).toHaveLength(1)
  })

  it.each(MONEY)('refuses (cancel_conflict) when the evidence is: %s', async (evidence) => {
    const { client, cancelWrites, refusals } = makeSupabase(evidence, { id: ORDER })
    const res = await handleTerminalPaymentFailed(client, userCancel(), noFinatic)
    expect(res.outcome).toBe('cancel_conflict')
    expect(cancelWrites()).toHaveLength(0)
    expect(refusals()).toHaveLength(evidence === 'unreadable' ? 0 : 1)
  })
})
