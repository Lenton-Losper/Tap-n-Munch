/**
 * @jest-environment jsdom
 *
 * Residual of #173 — the close-out notification's in-progress list is a hand-maintained
 * second copy of the active-status vocabulary, and it has fallen behind.
 *
 * OrderStatusBanner polls the active-table endpoint. An order that DISAPPEARS from that list
 * has been closed out, and the customer is told so. Which statuses count as "was in progress"
 * was written out inline as ['accepted','preparing','ready','pending'], while the real list
 * lives in lib/orders/active-order-visibility.ts as ACTIVE_ORDER_STATUSES and has since grown
 * `ready_for_terminal` (the card-machine flow) and `confirmed` (the terminal's word for
 * accepted). Neither is in the inline copy, so an order that reaches the card machine and is
 * then paid and closed tells the customer nothing at all.
 *
 * The two ends of the list are NOT symmetrical, which is why this is a derivation and not a
 * copy: `waiting_review` and `accepting` are also active, but an order vanishing from THOSE
 * has almost certainly been declined, and announcing "completed. Enjoy your meal!" over a
 * declined order is worse than saying nothing. Those two are named as pre-acceptance and
 * subtracted; everything else active is in progress, so a status added later is covered by
 * default rather than silently dropped the way `ready_for_terminal` was.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const RESTAURANT = 'rest-1'
const TABLE = 7
const POLL_MS = 5000

let pollQueue: Array<Array<Record<string, unknown>>> = []

jest.mock('@/lib/guest-orders/client', () => ({
  GUEST_ORDER_POLL_MS: 5000,
  fetchGuestActiveTableOrders: jest.fn(async () => ({
    orders: pollQueue.shift() ?? [],
    count: 0,
  })),
}))

import OrderStatusBanner from '@/components/OrderStatusBanner'
import {
  ACTIVE_ORDER_STATUSES,
  IN_PROGRESS_ORDER_STATUSES,
  PRE_ACCEPTANCE_ORDER_STATUSES,
} from '@/lib/orders/active-order-visibility'

let container: HTMLDivElement
let root: Root

/**
 * `paymentStatus` defaults to 'paid' because that is what a genuine close-out looks like: the
 * order was settled, the poll observed `paid`, and the row was later detached by the table
 * close. The earlier version of this file hardcoded 'pending' for every case, which said
 * nothing about payment and so could not distinguish a completed order from a cancelled one.
 */
function order(status: string, paymentStatus = 'paid') {
  return {
    id: 'order-1',
    order_number: 41,
    status,
    payment_status: paymentStatus,
    table_number: TABLE,
    restaurant_id: RESTAURANT,
    total: 30,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.useRealTimers()
})

/** Mounts the banner, serves `first` on poll 1 and `second` on poll 2, returns what it says. */
async function pollTwice(
  first: Array<Record<string, unknown>>,
  second: Array<Record<string, unknown>>,
): Promise<string> {
  pollQueue = [first, second]

  await act(async () => {
    root.render(<OrderStatusBanner restaurantId={RESTAURANT} tableNumber={TABLE} />)
  })
  // Poll 1 fires immediately on mount; let its promise settle.
  await act(async () => {
    await Promise.resolve()
  })

  await act(async () => {
    jest.advanceTimersByTime(POLL_MS)
  })
  await act(async () => {
    await Promise.resolve()
  })

  return container.textContent || ''
}

const CLOSE_OUT = /Order #41 completed\. Enjoy your meal!/

describe('#173 residual — close-out notification when an order leaves the active list', () => {
  it.each([
    // The gap in the report: the card-machine flow.
    ['ready_for_terminal'],
    // Same asymmetry, one status over: the terminal's word for accepted.
    ['confirmed'],
  ])('notifies when a %s order is closed out', async (status) => {
    const text = await pollTwice([order(status)], [])
    expect(text).toMatch(CLOSE_OUT)
  })

  // CONTROLS — already covered by the inline list, and must stay covered. If these ever go
  // red the derivation has narrowed rather than widened.
  it.each([['accepted'], ['preparing'], ['ready'], ['pending']])(
    'still notifies when a %s order is closed out',
    async (status) => {
      const text = await pollTwice([order(status)], [])
      expect(text).toMatch(CLOSE_OUT)
    },
  )

  // CONTROLS — these must pass BEFORE and AFTER. They are what stops the fix from being
  // "drop ACTIVE_ORDER_STATUSES in wholesale", which would announce a completed meal over
  // an order that was in fact declined before anyone accepted it.
  //
  // Deliberately marked PAID, so what silences them is provably the status gate and not the
  // payment gate added below. An unpaid fixture here would pass for the wrong reason.
  it.each([['waiting_review'], ['accepting']])(
    'says nothing when a %s order disappears (it was declined, not completed)',
    async (status) => {
      const text = await pollTwice([order(status, 'paid')], [])
      expect(text).not.toMatch(CLOSE_OUT)
    },
  )

  // CONTROL — the notification is tied to the disappearance, not to the mere passage of a
  // second poll.
  it('says nothing while the order is still on the list', async () => {
    const text = await pollTwice([order('ready_for_terminal')], [order('ready_for_terminal')])
    expect(text).not.toMatch(CLOSE_OUT)
  })
})

/**
 * A CANCEL must never read as a completion.
 *
 * The dashboard cancel (app/api/orders/[orderId]/status/route.ts:92-94) writes
 * `is_closed = true` AND `payment_status = 'cancelled'` in ONE patch, and the guest poll
 * filters on `is_closed` with no status filter (lib/guest-orders/queries.ts:204-213). So the
 * row leaves the poll in the very write that cancels it: the banner never observes
 * `status='cancelled'`, only a disappearance, and `prev` holds whatever preceded the cancel.
 *
 * Disappearance is therefore not evidence of completion. What distinguishes the two is the
 * last payment_status the poll actually saw -- `paid` for an order settled and later detached
 * by the table close, never `paid` for a cancel, because the cancel is atomic with the
 * removal. The banner already holds that value, so this costs no extra read.
 *
 * `isValidStaffStatusTransition` permits a cancel from every status except completed and
 * cancelled, so every in-progress status can reach here.
 */
describe('an order cancelled out of the active list is not announced as completed', () => {
  it.each([
    // The headline case: the card-machine flow, where declined-then-cancelled is routine.
    ['ready_for_terminal', 'terminal_pending'],
    ['confirmed', 'pending'],
    ['accepted', 'pending'],
    ['preparing', 'pending'],
    ['ready', 'pending'],
    ['pending', 'unpaid'],
  ])('says nothing when a %s order is cancelled (payment_status %s)', async (status, pay) => {
    const text = await pollTwice([order(status, pay)], [])
    expect(text).not.toMatch(CLOSE_OUT)
  })

  // CONTROL — the paid counterpart of each of those must STILL announce. Without it the fix
  // could be "never announce anything", which would pass every assertion above.
  it.each([
    ['ready_for_terminal'],
    ['confirmed'],
    ['accepted'],
    ['preparing'],
    ['ready'],
    ['pending'],
  ])('still announces a paid %s order detached by the table close', async (status) => {
    const text = await pollTwice([order(status, 'paid')], [])
    expect(text).toMatch(CLOSE_OUT)
  })

  // Casing is normalised the same way the rest of the banner does it (normalizePaid).
  it('treats a stray "Paid" as paid rather than silently swallowing the notification', async () => {
    const text = await pollTwice([order('ready_for_terminal', 'Paid')], [])
    expect(text).toMatch(CLOSE_OUT)
  })
})

/**
 * Structural pins on the derivation itself. These are not evidence of the bug -- they pass on
 * the fixed code by construction -- they are what makes the list unable to rot the way the
 * inline copy did. Whoever adds the next active status has to decide which side it falls on.
 */
describe('IN_PROGRESS_ORDER_STATUSES is derived, not a second hand-kept list', () => {
  it('accounts for every active status exactly once', () => {
    expect(
      [...IN_PROGRESS_ORDER_STATUSES, ...PRE_ACCEPTANCE_ORDER_STATUSES].sort(),
    ).toEqual([...ACTIVE_ORDER_STATUSES].sort())
  })

  it('carries the status the inline copy was missing', () => {
    expect(IN_PROGRESS_ORDER_STATUSES).toContain('ready_for_terminal')
  })

  it('excludes the pre-acceptance statuses and nothing else', () => {
    expect([...PRE_ACCEPTANCE_ORDER_STATUSES]).toEqual(['waiting_review', 'accepting'])
    for (const status of PRE_ACCEPTANCE_ORDER_STATUSES) {
      expect(IN_PROGRESS_ORDER_STATUSES).not.toContain(status)
    }
  })

  it('never contains a status that ends an order', () => {
    for (const terminal of ['completed', 'cancelled', 'declined']) {
      expect(IN_PROGRESS_ORDER_STATUSES).not.toContain(terminal)
    }
  })
})
