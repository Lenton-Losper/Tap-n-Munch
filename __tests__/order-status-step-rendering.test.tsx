/**
 * @jest-environment jsdom
 *
 * Regression cover for issue #132: widening the shared eligibility list made two statuses
 * newly RENDERABLE without teaching the renderers what they mean.
 *
 * `confirmed` is the terminal's word for `accepted`. The two transition tables occupy the
 * same slot:
 *   terminal   app/api/terminal/orders/[orderId]/status/route.ts:23   pending -> confirmed -> preparing
 *   dashboard  lib/orders/status-transitions.ts:27                    pending -> accepted  -> preparing
 * `pending -> confirmed` is the FIRST transition a staff member triggers on the terminal, so
 * an order sits in it for the whole of prep on that flow.
 *
 * `accepting` is the transient claim Accept takes on order_requests before the order row
 * exists (app/api/order-requests/[requestId]/accept/route.ts:66). It is explicitly rolled BACK
 * to `waiting_review` if createOrder() throws, so it must never be shown as review-complete.
 * It reaches a customer only through fetchGuestOrderById, which is the one guest query that
 * does not filter order_requests to waiting_review (lib/guest-orders/queries.ts:75).
 *
 * These assert the RENDERED step state, not the contents of any list.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const RESTAURANT = 'rest-1'
const TABLE = 7
const SESSION = 'sess_11111111-2222-3333-4444-555555555555'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useParams: () => ({ restaurantId: 'rest-1' }),
  useSearchParams: () => new URLSearchParams('table=7'),
}))

import { MenuOrderStatusTracker } from '@/components/menu/menu-order-status-tracker'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'

let container: HTMLDivElement
let root: Root

function order(status: string, over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    order_number: 41,
    status,
    payment_status: 'pending',
    payment_channel: 'card',
    table_number: TABLE,
    session_id: SESSION,
    restaurant_id: RESTAURANT,
    placed_at: new Date().toISOString(),
    total: 30,
    is_closed: false,
    ...over,
  }
}

function serve(orders: Array<Record<string, unknown>>) {
  ;(globalThis as any).fetch = jest.fn(async (url: string) => {
    const u = String(url)
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (u.includes('/api/guest/orders/by-session')) return ok({ orders, count: orders.length })
    if (u.includes('/api/guest/orders/active-table')) return ok({ orders, count: orders.length })
    const byId = u.match(/\/api\/guest\/orders\/([^/?]+)/)
    if (byId) {
      const found = orders.find((o) => String((o as { id: string }).id) === byId[1])
      if (found) return ok({ orders: [found], count: 1 })
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  })
}

/** label -> 'complete' | 'current' | 'todo', read off the rendered circles. */
function stepStates(): Record<string, string> {
  const out: Record<string, string> = {}
  container.querySelectorAll('div[class*="min-w-0"]').forEach((wrapper) => {
    const label = wrapper.querySelector('span[class*="text-center"]')?.textContent?.trim()
    if (!label) return
    const cls = wrapper.querySelector('div[class*="rounded-full"][class*="border-2"]')?.className || ''
    out[label] = cls.includes('bg-[#27AE60]')
      ? 'complete'
      : cls.includes('bg-white')
        ? 'current'
        : 'todo'
  })
  return out
}

function completedCount(states: Record<string, string>): number {
  return Object.values(states).filter((s) => s === 'complete').length
}

async function mountTracker(status: string, over: Record<string, unknown> = {}) {
  serve([order(status, over)])
  await act(async () => {
    root.render(
      <MenuOrderStatusTracker restaurantId={RESTAURANT} tableNumber={TABLE} sessionId={SESSION} />,
    )
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function mountBanner(status: string, over: Record<string, unknown> = {}) {
  serve([order(status, over)])
  await act(async () => {
    root.render(<ActiveOrderBanner />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('flashtap_session_v1', SESSION)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  jest.clearAllMocks()
})

describe('tracker step rendering for terminal-flow statuses (#132)', () => {
  it('renders `confirmed` exactly as it renders `accepted`', async () => {
    // Same slot in the two transition tables, so the customer must see the same thing.
    await mountTracker('accepted')
    const acceptedStates = stepStates()

    await act(async () => { root.render(null) })
    await mountTracker('confirmed')
    const confirmedStates = stepStates()

    expect(confirmedStates).toEqual(acceptedStates)
  })

  it('marks Received and Accepted done once the terminal confirms the order', async () => {
    await mountTracker('confirmed')
    const states = stepStates()
    expect(states['Received']).toBe('complete')
    expect(states['Accepted']).toBe('complete')
  })

  it('never moves the progress bar BACKWARDS on pending -> confirmed', async () => {
    // The reported symptom: staff press Accept on the terminal and the bar drops from
    // 2 steps done to 1. This is the assertion that pins it.
    await mountTracker('pending')
    const pendingDone = completedCount(stepStates())

    await act(async () => { root.render(null) })
    await mountTracker('confirmed')
    const confirmedDone = completedCount(stepStates())

    expect(confirmedDone).toBeGreaterThanOrEqual(pendingDone)
  })

  it('does not claim review is finished while Accept is still in flight', async () => {
    // `accepting` can roll back to waiting_review, so showing "Waiting for Review" as done
    // would be claiming an outcome that has not happened.
    await mountTracker('accepting')
    expect(stepStates()['Waiting for Review']).not.toBe('complete')
  })

  it('renders `accepting` exactly as it renders `waiting_review`', async () => {
    await mountTracker('waiting_review')
    const waitingStates = stepStates()

    await act(async () => { root.render(null) })
    await mountTracker('accepting')

    expect(stepStates()).toEqual(waitingStates)
  })

  it('does not hand a terminal-confirmed order a new Ready to Pay control', async () => {
    // The display fix normalises `confirmed` to `accepted` for what the customer is TOLD, but
    // must not normalise it for payment controls: that would add a POST-triggering button to a
    // state that never had one. Payment surface stays exactly as it was.
    await mountTracker('confirmed')
    const payButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      /ready to pay/i.test(b.textContent || ''),
    )
    expect(payButtons.length).toBe(0)
  })

  it('still marks a paid, ready order fully through prep', async () => {
    // Guards the statuses that were already correct against the fix.
    await mountTracker('ready', { payment_status: 'paid' })
    const states = stepStates()
    expect(states['Preparing']).toBe('complete')
    expect(states['Ready']).toBe('complete')
    expect(states['Paid']).toBe('complete')
  })
})

describe('landing-page banner text for newly-visible statuses (#132)', () => {
  it('tells a terminal-confirmed order the same thing as an accepted one', async () => {
    await mountBanner('accepted', { payment_status: 'paid' })
    const acceptedText = container.textContent

    await act(async () => { root.render(null) })
    await mountBanner('confirmed', { payment_status: 'paid' })

    expect(container.textContent).toBe(acceptedText)
  })

  it('does not fall back to the vague placeholder for statuses it now renders', async () => {
    for (const status of ['waiting_review', 'confirmed', 'preparing']) {
      await mountBanner(status, { payment_status: 'paid' })
      expect(container.textContent).not.toContain('Order in progress')
      await act(async () => { root.render(null) })
    }
  })
})
