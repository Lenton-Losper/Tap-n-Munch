/**
 * @jest-environment jsdom
 *
 * Issue #173 — OrderStatusBanner is the sixth renderer of order status, and the only one #131
 * and #132 did not reach. It re-decided for itself which words mean which state, and got two
 * of them wrong:
 *
 *   1. `confirmed` -- the terminal's word for `accepted`
 *      (app/api/terminal/orders/[orderId]/status/route.ts) -- had no case at all, so the first
 *      thing a staff member does on the terminal told the customer nothing, while the identical
 *      dashboard action (`accepted`) told them their order was accepted.
 *   2. On a transition to `ready` from `accepted`, the banner said the order "is being
 *      prepared", with a cooking icon and info styling. The order is ready; the words said it
 *      was not. Same defect class #131 fixed in the receipt badge mapper.
 *
 * The fix normalises status once at ingestion rather than adding two more cases, so the
 * component holds one vocabulary instead of re-deciding per switch. Two further consequences
 * fall out of that and are pinned below: `confirmed -> accepted` no longer double-announces
 * acceptance, and a vanished terminal-confirmed order now gets the same close-out the dashboard
 * flow already got.
 *
 * Asserted against the MOUNTED banner and the text a customer would read, driven through two
 * polls of the real component -- the notification only exists as a consequence of a status
 * diff, so a unit test on the mapper would not be evidence that it fires.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const RESTAURANT = 'rest-1'
const TABLE = 7
const POLL_MS = 5000

const fetchActive = jest.fn()

jest.mock('@/lib/guest-orders/client', () => ({
  fetchGuestActiveTableOrders: (...args: unknown[]) => fetchActive(...args),
  GUEST_ORDER_POLL_MS: 5000,
}))

import OrderStatusBanner from '@/components/OrderStatusBanner'

let container: HTMLDivElement
let root: Root

function order(status: string) {
  return [
    {
      id: 'order-1',
      order_number: 41,
      status,
      payment_status: 'pending',
      table_number: TABLE,
    },
  ]
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  jest.useFakeTimers()
  fetchActive.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  jest.useRealTimers()
})

/**
 * Mounts the banner, lets it record `from` as the baseline, then polls once more with `to`.
 * Returns the notification text the customer would be reading.
 */
async function transition(from: string, to: string): Promise<string> {
  fetchActive.mockResolvedValue({ orders: order(from) })
  await act(async () => {
    root.render(<OrderStatusBanner restaurantId={RESTAURANT} tableNumber={TABLE} />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  fetchActive.mockResolvedValue({ orders: order(to) })
  await act(async () => {
    await jest.advanceTimersByTimeAsync(POLL_MS)
  })
  return container.textContent || ''
}

/** Mounts with an order at `from`, then polls with the order gone from the active list. */
async function disappearFrom(from: string): Promise<string> {
  fetchActive.mockResolvedValue({ orders: order(from) })
  await act(async () => {
    root.render(<OrderStatusBanner restaurantId={RESTAURANT} tableNumber={TABLE} />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  fetchActive.mockResolvedValue({ orders: [] })
  await act(async () => {
    await jest.advanceTimersByTimeAsync(POLL_MS)
  })
  return container.textContent || ''
}

describe('OrderStatusBanner status vocabulary (#173)', () => {
  it('control: the dashboard accept path already notifies', async () => {
    // If this fails, the harness is not driving the component and nothing below is evidence.
    expect(await transition('pending', 'accepted')).toContain('Order #41 has been accepted!')
  })

  it('notifies on the terminal confirm, the same as the dashboard accept', async () => {
    expect(await transition('pending', 'confirmed')).toContain('Order #41 has been accepted!')
  })

  it('says a ready order is ready, not that it is being prepared', async () => {
    const text = await transition('accepted', 'ready')
    expect(text).toContain('Order #41 is ready!')
    expect(text).not.toContain('is being prepared')
  })

  it('says a ready order is ready on the terminal path too', async () => {
    const text = await transition('confirmed', 'ready')
    expect(text).toContain('Order #41 is ready!')
    expect(text).not.toContain('is being prepared')
  })

  it('does not re-announce acceptance when the two surfaces disagree on the word', async () => {
    // confirmed and accepted are the same state. A row rewritten from one to the other is not
    // an event the customer should be told about twice.
    expect(await transition('confirmed', 'accepted')).toBe('')
  })

  it('stays silent on a status it has no words for', async () => {
    // The unmapped path must remain a no-op, not a misleading default.
    expect(await transition('pending', 'ready_for_terminal')).toBe('')
  })

  it('control: closes out a vanished dashboard-accepted order', async () => {
    expect(await disappearFrom('accepted')).toContain('completed. Enjoy your meal!')
  })

  it('closes out a vanished terminal-confirmed order too', async () => {
    // The disappearance path lists the in-progress statuses separately. Because status is now
    // normalised at ingestion, a terminal-confirmed order reaches it as `accepted` and gets the
    // same close-out. This is a behaviour change: before, a vanished confirmed order said
    // nothing, the same asymmetry as defect 1.
    expect(await disappearFrom('confirmed')).toContain('completed. Enjoy your meal!')
  })

  it('still announces a decline', async () => {
    expect(await transition('pending', 'declined')).toContain('was declined')
  })

  it('still announces completion', async () => {
    expect(await transition('ready', 'completed')).toContain('completed. Enjoy your meal!')
  })
})
