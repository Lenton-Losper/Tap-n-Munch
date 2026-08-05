/**
 * @jest-environment jsdom
 *
 * Issue #132 — the landing-page ActiveOrderBanner never rendered.
 *
 * Two independent causes, both asserted here against the MOUNTED component (the landing page
 * is the artefact the customer sees, so a passing predicate unit test would not have been
 * evidence that the banner appears):
 *
 *   1. ActiveOrderBanner called useActiveOrders(restaurantId, tableNumber) with no session id.
 *      hooks/useActiveOrders.ts fails closed without one -- deliberately, so a guest never
 *      sees another customer's table-wide orders -- so activeOrder was permanently null and
 *      the hook never even issued a request.
 *   2. Its private isBannerEligibleOrder omitted `waiting_review`, so a QR order awaiting
 *      staff Accept showed nothing on the landing page.
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

import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'

let fetchMock: jest.Mock
let container: HTMLDivElement
let root: Root

/** Every active-table request the banner's hook issued. */
function activeTableCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/api/guest/orders/active-table'))
}

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    order_number: 41,
    status: 'accepted',
    payment_status: 'paid',
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

/** Serves the active-table endpoint; the by-id endpoint 404s (no last_order_id in play). */
function serve(orders: Array<Record<string, unknown>>) {
  fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/guest/orders/active-table')) {
      return { ok: true, status: 200, json: async () => ({ orders, count: orders.length }) }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Order not found' }) }
  })
  ;(globalThis as any).fetch = fetchMock
}

async function mount() {
  await act(async () => {
    root.render(<ActiveOrderBanner />)
  })
  // let the hook's fetch + setState settle
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  // The customer holds a session; this is the normal landing-page state.
  localStorage.setItem('flashtap_session_v1', SESSION)
  localStorage.setItem('flashtap_session_table_v1', String(TABLE))
  localStorage.setItem('flashtap_session_restaurant_v1', RESTAURANT)
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

describe('ActiveOrderBanner (#132)', () => {
  it('asks the server for the customer\'s active orders at all', async () => {
    serve([order()])
    await mount()
    // Before the fix this array was empty: the hook bailed out before fetching.
    expect(activeTableCalls().length).toBeGreaterThan(0)
  })

  it('scopes that request to the customer\'s own session', async () => {
    serve([order()])
    await mount()
    const url = new URL(activeTableCalls()[0], 'http://localhost')
    expect(url.searchParams.get('session_id')).toBe(SESSION)
  })

  it('renders the banner for an active order', async () => {
    serve([order()])
    await mount()
    expect(container.textContent).toContain('Order #41')
    expect(container.textContent).toContain('View Receipt')
  })

  it('renders for a QR order still awaiting staff review', async () => {
    // waiting_review was missing from the banner's eligibility list, though the tracker's
    // equivalent includes it, so the landing page went blank at exactly the moment the
    // customer most wants reassurance that their order arrived.
    serve([order({ status: 'waiting_review', payment_status: 'waiting_review' })])
    await mount()
    expect(container.textContent).toContain('Order #41')
  })

  it('renders while the kitchen is preparing the order', async () => {
    // `preparing` is written by both the dashboard and the terminal (see #131) and was
    // likewise absent, so the banner vanished mid-order.
    serve([order({ status: 'preparing' })])
    await mount()
    expect(container.textContent).toContain('Order #41')
  })

  it('still shows nothing once the order is done or cancelled', async () => {
    for (const status of ['completed', 'cancelled', 'declined']) {
      serve([order({ status })])
      await mount()
      expect(container.textContent).toBe('')
      await act(async () => {
        root.render(null)
      })
    }
  })

  it('shows nothing when the customer holds no session', async () => {
    // The fail-closed guarantee must survive the fix: no session, no table-wide leak.
    localStorage.removeItem('flashtap_session_v1')
    serve([order()])
    await mount()
    expect(container.textContent).toBe('')
    expect(activeTableCalls().length).toBe(0)
  })
})
