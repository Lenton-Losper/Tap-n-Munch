/**
 * A DASHBOARD CANCEL STOPS THE KITCHEN, AND SAYS WHAT IT COULD NOT STOP.
 *
 * Sprint 2026-09-28 brief (Riviera #160 investigation). PATCH /api/orders/[orderId]/status
 * cancelled the ORDER and never touched its order_lines, so a cancelled order's dishes stayed
 * outstanding on the station boards and the kitchen kept cooking them. It now voids every
 * still-working half through voidOutstandingOrderLines (the helper every other cancel path uses)
 * and reports the lines a station had already finished, which no cancel can un-make.
 */
import { PATCH } from '@/app/api/orders/[orderId]/status/route'
import { voidOutstandingOrderLines } from '@/lib/orders/order-lines'

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (value: unknown) => value instanceof Response,
  requireStaffPermission: async () => ({ userId: 'staff-7', restaurantId: 'rest-1' }),
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

type Line = { id: string; kitchen_state: string | null; bar_state: string | null; name_snapshot: string; quantity: number }
let lines: Line[]
let events: Record<string, unknown>[]
let orderLinesReadFails: boolean
let orderLinesTouched: boolean

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'audit_logs') return { insert: async () => ({ error: null }) }
      if (table === 'order_line_events') {
        return {
          insert: async (rows: Record<string, unknown>[]) => {
            events.push(...rows)
            return { error: null }
          },
        }
      }
      if (table === 'order_lines') {
        orderLinesTouched = true
        let patch: Record<string, unknown> | null = null
        let id: string | null = null
        const b: Record<string, unknown> = {
          select: () => b,
          update: (p: Record<string, unknown>) => ((patch = p), b),
          eq: (col: string, v: unknown) => {
            if (patch && col === 'id') id = String(v)
            return b
          },
          then: (resolve: (v: unknown) => unknown) => {
            if (!patch) {
              return Promise.resolve(
                orderLinesReadFails
                  ? { data: null, error: { message: 'read failed' } }
                  : { data: lines.map((l) => ({ ...l })), error: null },
              ).then(resolve)
            }
            const line = lines.find((l) => l.id === id)
            if (line) Object.assign(line, patch)
            return Promise.resolve({ data: null, error: null }).then(resolve)
          },
        }
        return b
      }
      // orders
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'order-1', restaurant_id: 'rest-1', status: 'preparing', payment_status: 'pending' },
              error: null,
            }),
          }),
        }),
        update: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            is: () => b,
            select: () => ({
              maybeSingle: async () => ({
                data: { id: 'order-1', status: 'cancelled', payment_status: 'cancelled', is_closed: true },
                error: null,
              }),
            }),
          }
          return b
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeSupabase() }))

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request('https://example.test/api/orders/order-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orderId: 'order-1' }) },
  )
}

beforeEach(() => {
  events = []
  orderLinesReadFails = false
  orderLinesTouched = false
  lines = [
    { id: 'L1', kitchen_state: 'outstanding', bar_state: null, name_snapshot: 'Modena Pasta', quantity: 1 },
    { id: 'L2', kitchen_state: 'cooked', bar_state: null, name_snapshot: 'Steak', quantity: 1 },
    { id: 'L3', kitchen_state: 'ready', bar_state: null, name_snapshot: 'Soup', quantity: 2 },
    { id: 'L4', kitchen_state: 'ready', bar_state: 'outstanding', name_snapshot: 'Combo', quantity: 1 },
    { id: 'L5', kitchen_state: 'voided', bar_state: null, name_snapshot: 'Salad', quantity: 1 },
  ]
})

describe('PATCH /api/orders/[orderId]/status -- cancel', () => {
  it('voids every still-working half, with system events attributed to the staff member', async () => {
    const res = await patch({ status: 'cancelled', reason: 'guest left' })
    expect(res.status).toBe(200)
    expect(lines.find((l) => l.id === 'L1')!.kitchen_state).toBe('voided')
    expect(lines.find((l) => l.id === 'L2')!.kitchen_state).toBe('voided')
    expect(lines.find((l) => l.id === 'L4')!.bar_state).toBe('voided')
    // A finished half is not rewritten.
    expect(lines.find((l) => l.id === 'L3')!.kitchen_state).toBe('ready')
    expect(lines.find((l) => l.id === 'L4')!.kitchen_state).toBe('ready')
    expect(events.map((e) => `${e.order_line_id}:${e.station}:${e.from_state}`).sort()).toEqual([
      'L1:kitchen:outstanding',
      'L2:kitchen:cooked',
      'L4:bar:outstanding',
    ])
    for (const e of events) {
      expect(e).toMatchObject({ to_state: 'voided', actor_kind: 'system', actor_user_id: 'staff-7' })
    }
  })

  it('reports the lines it could not void -- food that is still coming', async () => {
    const body = await (await patch({ status: 'cancelled' })).json()
    expect(body.success).toBe(true)
    expect(body.lines_voided).toBe(3)
    expect(body.lines_void_failed).toBe(false)
    expect(body.lines_not_voided).toEqual([
      { line_id: 'L3', name: 'Soup', quantity: 2, kitchen_state: 'ready', bar_state: null },
      { line_id: 'L4', name: 'Combo', quantity: 1, kitchen_state: 'ready', bar_state: 'voided' },
    ])
  })

  it('a failed void does not un-report the cancel; it says the lines were not handled', async () => {
    orderLinesReadFails = true
    const res = await patch({ status: 'cancelled' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.lines_void_failed).toBe(true)
    expect(body.lines_voided).toBeNull()
  })

  it('a non-cancel status change leaves the lines alone', async () => {
    const res = await patch({ status: 'ready' })
    expect(res.status).toBe(200)
    expect(orderLinesTouched).toBe(false)
    expect((await res.json()).lines_voided).toBeUndefined()
  })
})

describe('voidOutstandingOrderLines().notVoided', () => {
  it('is empty when everything could be voided', async () => {
    lines = [{ id: 'L1', kitchen_state: 'outstanding', bar_state: 'cooked', name_snapshot: 'X', quantity: 1 }]
    const result = await voidOutstandingOrderLines(makeSupabase() as never, {
      orderId: 'order-1', restaurantId: 'rest-1', actorKind: 'system', actorUserId: null,
    })
    expect(result).toEqual({ voidedLineCount: 1, notVoided: [] })
  })

  it('lists a collected line, and never an already-voided one', async () => {
    lines = [
      { id: 'C', kitchen_state: 'collected', bar_state: null, name_snapshot: 'Chips', quantity: 1 },
      { id: 'V', kitchen_state: 'voided', bar_state: null, name_snapshot: 'Gone', quantity: 1 },
    ]
    const result = await voidOutstandingOrderLines(makeSupabase() as never, {
      orderId: 'order-1', restaurantId: 'rest-1', actorKind: 'system', actorUserId: null,
    })
    expect(result.voidedLineCount).toBe(0)
    expect(result.notVoided.map((l) => l.id)).toEqual(['C'])
  })
})
