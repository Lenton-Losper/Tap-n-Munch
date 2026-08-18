/**
 * @jest-environment jsdom
 *
 * jsdom, not the project default of node: the module reads `window.localStorage` for the mute
 * setting and `BroadcastChannel` for cross-tab de-duplication, and both are browser APIs.
 */
/**
 * THE INCOMING-ORDER SOUND ALERT.
 *
 * The defect this exists to hold shut: a QR customer's order sounded TWICE. Their submission
 * inserts an `order_requests` row (chime one); staff Accept calls createOrder, which writes an
 * `orders` row at status 'pending' (chime two) — on the very dashboard that just accepted it.
 *
 * The other three constraints are asserted here too, because each one is a way for the feature to
 * be silently useless: firing on page load, having no mute, or having a mute that does not
 * survive a refresh.
 */
import {
  announceIncomingOrder,
  orderAlertKey,
  isIncomingOrderInsert,
  claimOrderAlert,
  suppressOrderAlert,
  isOrderAlertMuted,
  setOrderAlertMuted,
  getAlertArmedState,
  ORDER_ALERT_MUTE_KEY,
  __resetOrderAlertStateForTests,
} from '@/lib/dashboard/order-alert-sound'

jest.mock('@/lib/dashboard/order-realtime', () => ({
  playNewOrderSound: jest.fn(),
  getNewOrderAudioContext: jest.fn(() => null),
}))

const REQ = '11111111-1111-4111-8111-111111111111'
const ORD = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  __resetOrderAlertStateForTests()
  window.localStorage.clear()
  jest.clearAllMocks()
})

describe('one order, one chime, across two tables', () => {
  it('gives a request and the order it becomes the SAME key — the defect, as a rule', () => {
    expect(orderAlertKey({ id: REQ }, 'order_requests')).toBe(`req:${REQ}`)
    expect(orderAlertKey({ id: ORD, source_request_id: REQ }, 'orders')).toBe(`req:${REQ}`)
  })

  it('sounds for the customer submission, then STAYS SILENT when staff accept it', () => {
    const first = announceIncomingOrder({ id: REQ }, 'order_requests')
    const second = announceIncomingOrder(
      { id: ORD, source_request_id: REQ, status: 'pending' },
      'orders',
    )
    expect(first).toEqual({ notify: true, sounded: true })
    expect(second).toEqual({ notify: false, sounded: false })
  })

  it('STILL sounds for a POS order, which has no source request — the control', () => {
    // Without this, "never sounds twice" would be satisfied by never sounding at all.
    expect(orderAlertKey({ id: ORD }, 'orders')).toBe(`ord:${ORD}`)
    expect(announceIncomingOrder({ id: ORD, status: 'pending' }, 'orders')).toEqual({
      notify: true,
      sounded: true,
    })
  })

  it('sounds once per DISTINCT order, not once ever', () => {
    const a = announceIncomingOrder({ id: 'req-a' }, 'order_requests')
    const b = announceIncomingOrder({ id: 'req-b' }, 'order_requests')
    expect(a.sounded).toBe(true)
    expect(b.sounded).toBe(true)
  })

  it('refuses to sound for a row with no id, because it could not be de-duplicated', () => {
    expect(orderAlertKey({}, 'orders')).toBeNull()
    expect(announceIncomingOrder({ status: 'pending' }, 'orders').sounded).toBe(false)
  })
})

describe('an order this dashboard just accepted', () => {
  it('stays silent even when the request was on screen at page load', () => {
    // The ordinary case: staff arrive, the request is already listed (no chime — page load is
    // silent), they accept it. Their own click must not chime at them.
    suppressOrderAlert({ requestId: REQ, orderId: ORD })
    expect(
      announceIncomingOrder({ id: ORD, source_request_id: REQ, status: 'pending' }, 'orders'),
    ).toEqual({ notify: false, sounded: false })
  })

  it('suppresses by order id too, in case the source link is ever absent', () => {
    suppressOrderAlert({ requestId: null, orderId: ORD })
    expect(announceIncomingOrder({ id: ORD, status: 'pending' }, 'orders').sounded).toBe(false)
  })
})

describe('page load', () => {
  /**
   * Both subscriptions call this only from `onChange`, never `onInitial`. Asserted as a source
   * scan because the subscription wiring lives in a component that needs a live Supabase channel.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const src = readFileSync(join(process.cwd(), 'components/orders-dashboard.tsx'), 'utf8')

  it('never announces from onInitial', () => {
    const initialBlocks = src.split('onInitial:').slice(1).map((b) => b.slice(0, 400))
    expect(initialBlocks.length).toBeGreaterThan(0)
    for (const block of initialBlocks) {
      expect(block).not.toMatch(/announceIncomingOrder|playNewOrderSound/)
    }
  })

  it('announces from both onChange handlers, and nothing calls the raw tone directly', () => {
    expect(src.match(/announceIncomingOrder\(/g) ?? []).toHaveLength(2)
    expect(src).not.toMatch(/[^a-zA-Z]playNewOrderSound\(/)
  })
})

describe('mute', () => {
  it('silences the tone but STILL surfaces the order', () => {
    // Muting is about noise, not about hiding orders. A muted dashboard that also stopped showing
    // new orders would be a far worse defect than the one being fixed.
    setOrderAlertMuted(true)
    expect(announceIncomingOrder({ id: REQ }, 'order_requests')).toEqual({
      notify: true,
      sounded: false,
    })
  })

  it('survives a refresh, because it is written to localStorage', () => {
    setOrderAlertMuted(true)
    expect(window.localStorage.getItem(ORDER_ALERT_MUTE_KEY)).toBe('1')
    __resetOrderAlertStateForTests() // in-memory state gone, as after a reload
    expect(isOrderAlertMuted()).toBe(true)
  })

  it('defaults to AUDIBLE when nothing was ever stored', () => {
    expect(isOrderAlertMuted()).toBe(false)
  })

  it('a muted tab still CONSUMES the key, so a sibling tab does not become a second announcer', () => {
    setOrderAlertMuted(true)
    announceIncomingOrder({ id: REQ }, 'order_requests')
    setOrderAlertMuted(false)
    expect(announceIncomingOrder({ id: REQ }, 'order_requests').sounded).toBe(false)
  })
})

describe('the armed indicator', () => {
  it('reports muted when silenced', () => {
    setOrderAlertMuted(true)
    expect(getAlertArmedState()).toBe('muted')
  })

  it('reports blocked when the browser has granted no audio', () => {
    // getNewOrderAudioContext is mocked to null — the same situation as a suspended context from
    // a staff member's point of view: nothing will be heard.
    expect(getAlertArmedState()).toBe('blocked')
  })

  it('distinguishes blocked from muted, which need different actions', () => {
    expect(getAlertArmedState()).toBe('blocked')
    setOrderAlertMuted(true)
    expect(getAlertArmedState()).toBe('muted')
  })
})

describe('what counts as an incoming order', () => {
  it('ignores an orders INSERT that is not pending', () => {
    expect(isIncomingOrderInsert({ id: ORD, status: 'completed' }, 'orders')).toBe(false)
    expect(announceIncomingOrder({ id: ORD, status: 'completed' }, 'orders').sounded).toBe(false)
  })

  it('treats every order_requests INSERT as incoming', () => {
    expect(isIncomingOrderInsert({ id: REQ }, 'order_requests')).toBe(true)
  })
})

describe('claiming', () => {
  it('is first-come, and only once', () => {
    expect(claimOrderAlert('k')).toBe(true)
    expect(claimOrderAlert('k')).toBe(false)
  })

  it('refuses an empty key', () => {
    expect(claimOrderAlert('')).toBe(false)
  })
})
