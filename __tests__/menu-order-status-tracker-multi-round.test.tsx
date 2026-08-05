/**
 * @jest-environment jsdom
 *
 * Issue #134 — on a tab with three rounds, only the last order's status was visible.
 *
 * The tracker resolved exactly one order, from a single `last_order_id` in sessionStorage that
 * every new order overwrites (app/menu/[restaurantId]/cart/page.tsx sets it on submit). Rounds
 * one and two became invisible the moment round three was placed, even though they were still
 * being cooked.
 *
 * Asserted against the MOUNTED tracker, because "which orders can the customer see" is only
 * answerable at the rendered layer.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { MenuOrderStatusTracker } from '@/components/menu/menu-order-status-tracker'

const RESTAURANT = 'rest-1'
const TABLE = 7
const SESSION = 'sess_11111111-2222-3333-4444-555555555555'

let fetchMock: jest.Mock
let container: HTMLDivElement
let root: Root

function order(id: string, orderNumber: number, over: Record<string, unknown> = {}) {
  return {
    id,
    order_number: orderNumber,
    status: 'preparing',
    payment_status: 'paid',
    payment_channel: 'card',
    table_number: TABLE,
    session_id: SESSION,
    restaurant_id: RESTAURANT,
    placed_at: new Date(Date.now() - orderNumber * 1000).toISOString(),
    total: 30,
    is_closed: false,
    ...over,
  }
}

const ROUNDS = [
  order('order-1', 41),
  order('order-2', 42),
  order('order-3', 43),
]

function serve(orders: Array<Record<string, unknown>>) {
  fetchMock = jest.fn(async (url: string) => {
    const u = String(url)
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

    if (u.includes('/api/guest/orders/by-session')) {
      return ok({ orders, count: orders.length })
    }
    if (u.includes('/api/guest/orders/active-table')) {
      return ok({ orders, count: orders.length })
    }
    const byId = u.match(/\/api\/guest\/orders\/([^/?]+)/)
    if (byId) {
      const found = orders.find((o) => String((o as { id: string }).id) === byId[1])
      if (found) return ok({ orders: [found], count: 1 })
      return { ok: false, status: 404, json: async () => ({ error: 'Order not found' }) }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  })
  ;(globalThis as any).fetch = fetchMock
}

async function mount() {
  await act(async () => {
    root.render(
      <MenuOrderStatusTracker
        restaurantId={RESTAURANT}
        tableNumber={TABLE}
        sessionId={SESSION}
      />,
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('flashtap_session_v1', SESSION)
  // What the cart wrote on the most recent submit -- round three only.
  sessionStorage.setItem('last_order_id', 'order-3')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  jest.clearAllMocks()
})

describe('MenuOrderStatusTracker with several rounds (#134)', () => {
  it('shows every round still in progress, not just the most recent', async () => {
    serve(ROUNDS)
    await mount()
    const text = container.textContent || ''
    expect(text).toContain('Order #41')
    expect(text).toContain('Order #42')
    expect(text).toContain('Order #43')
  })

  it('does not depend on last_order_id to find the earlier rounds', async () => {
    // The stored id points at round three; rounds one and two must still appear.
    sessionStorage.setItem('last_order_id', 'order-3')
    serve(ROUNDS)
    await mount()
    expect(container.textContent).toContain('Order #41')
  })

  it('still works when sessionStorage was never written at all', async () => {
    // A customer returning on a fresh tab has no last_order_id; the session still identifies them.
    sessionStorage.clear()
    serve(ROUNDS)
    await mount()
    const text = container.textContent || ''
    expect(text).toContain('Order #41')
    expect(text).toContain('Order #43')
  })

  it('drops a round once it is completed and keeps the ones still cooking', async () => {
    serve([
      order('order-1', 41, { status: 'completed' }),
      order('order-2', 42),
      order('order-3', 43),
    ])
    await mount()
    const text = container.textContent || ''
    expect(text).not.toContain('Order #41')
    expect(text).toContain('Order #42')
    expect(text).toContain('Order #43')
  })

  it('renders nothing when no round is active', async () => {
    serve([order('order-1', 41, { status: 'completed' })])
    await mount()
    expect(container.textContent).toBe('')
  })

  it('keeps a single Ready to Pay control rather than one per round', async () => {
    // Deliberate non-change: multiplying a payment-notification control across rounds would be
    // a payment-surface change, which is out of scope for a display fix. See the report.
    serve(ROUNDS.map((o) => ({ ...o, status: 'ready', payment_status: 'cash_pending' })))
    await mount()
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) =>
      /ready to pay/i.test(b.textContent || ''),
    )
    expect(buttons.length).toBeLessThanOrEqual(1)
  })
})
