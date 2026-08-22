import { NextRequest } from 'next/server'
import { resolveTabPinPolicy, tabPinIsDisclosable } from '@/lib/tabs/pin-policy'

/**
 * #236 — SETTING pin_required WITHOUT A PIN MUST NOT REMOVE THE PIN CHECK.
 *
 * The predicate used to be inline in the route: `pin_required !== false && Boolean(tab_pin)`.
 * `Boolean(null)` is false, so a tab with the flag set and no PIN resolved to "no PIN required" and
 * this route — the one that lets a stranger join an open tab — waved them through. A restaurant
 * that believed it had protection had none.
 *
 * THE ROUTE IS DRIVEN, NOT THE PREDICATE. A test that only called resolveTabPinPolicy would pass
 * even if the route ignored it entirely, which is the exact shape of defect that shipped here
 * before: the logic was right somewhere and not wired where it counted.
 *
 * BOTH DIRECTIONS, because the two failure modes pull opposite:
 *   too OPEN   — the misconfigured tab silently admits anyone (today's defect)
 *   too CLOSED — a correctly configured tab stops admitting its members, which is an outage for
 *                every table with a working PIN
 */
const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'

type Row = Record<string, unknown>
const state: { tab: Row } = { tab: {} }

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => RESTAURANT,
}))
jest.mock('@/lib/session-token', () => ({
  issueTokenForOpenTab: async () => 'session-token-issued',
}))
jest.mock('@/lib/tabs/generate-tab-pin', () => ({ generateTabPin: () => '1234' }))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const self = () => b
      b.select = () => self()
      b.eq = () => self()
      b.update = () => self()
      b.insert = () => ({ error: null })
      b.single = async () => ({ data: state.tab, error: null })
      b.maybeSingle = async () => ({ data: state.tab, error: null })
      b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [state.tab], error: null }).then(r)
      return b
    },
  }),
}))

const tab = (over: Row = {}): Row => ({
  id: TAB,
  restaurant_id: RESTAURANT,
  table_id: 'table-1',
  table_number: 4,
  status: 'open',
  members: [],
  pin_required: true,
  tab_pin: '4321',
  pin_reset_token: null,
  ...over,
})

async function join(body: Row) {
  const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
  const req = new NextRequest(`http://localhost/api/tabs/${TAB}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // tableNumber is validated before the PIN logic; omitting it 400s and every assertion
    // below would then be testing the arg check rather than the PIN policy.
    body: JSON.stringify({ restaurantId: RESTAURANT, tableNumber: 4, ...body }),
  })
  const res = await POST(req, { params: Promise.resolve({ tabId: TAB }) } as never)
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('the misconfigured tab — flag set, tab_pin NULL', () => {
  beforeEach(() => {
    state.tab = tab({ pin_required: true, tab_pin: null })
  })

  it('does NOT silently admit a caller who sends no PIN', async () => {
    const res = await join({ sessionId: 'stranger-session' })
    expect(res.status).toBe(403)
    expect(res.body?.success).not.toBe(true)
  })

  it('does not admit a caller who guesses a PIN either', async () => {
    const res = await join({ sessionId: 'stranger-session', pin: '0000' })
    expect(res.status).toBe(403)
  })

  it('refuses with a code the client can act on, not a bare PIN prompt', async () => {
    // 'ask staff' and 'show the PIN prompt' are different remedies. Only staff can fix this one.
    const res = await join({ sessionId: 'stranger-session' })
    expect(res.body?.code).toBe('TAB_PIN_UNAVAILABLE')
  })

  it('an empty-string PIN is treated the same as a missing one', async () => {
    state.tab = tab({ pin_required: true, tab_pin: '   ' })
    const res = await join({ sessionId: 'stranger-session' })
    expect(res.status).toBe(403)
    expect(res.body?.code).toBe('TAB_PIN_UNAVAILABLE')
  })
})

describe('the correctly configured tab — unchanged behaviour', () => {
  beforeEach(() => {
    state.tab = tab({ pin_required: true, tab_pin: '4321' })
  })

  it('still admits the right PIN', async () => {
    // The other half of the asymmetry. If this stops working, every table with a real PIN is
    // locked out and the fix has traded a security hole for an outage.
    const res = await join({ sessionId: 's1', pin: '4321' })
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
  })

  it('still rejects the wrong PIN, as "Incorrect PIN" rather than the misconfigured refusal', async () => {
    const res = await join({ sessionId: 's1', pin: '9999' })
    expect(res.status).toBe(403)
    expect(res.body?.code).not.toBe('TAB_PIN_UNAVAILABLE')
  })

  it('still asks for a PIN when none is sent', async () => {
    const res = await join({ sessionId: 's1' })
    expect(res.status).toBe(403)
    expect(res.body?.code).not.toBe('TAB_PIN_UNAVAILABLE')
  })
})

describe('a tab with the flag OFF is unaffected', () => {
  it('joins with no PIN, exactly as before', async () => {
    state.tab = tab({ pin_required: false, tab_pin: null })
    const res = await join({ sessionId: 's1' })
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
  })
})

describe('the policy itself', () => {
  it('never returns none for a set flag', () => {
    for (const tab_pin of [null, undefined, '', '   ']) {
      expect(resolveTabPinPolicy({ pin_required: true, tab_pin }).mode).toBe('misconfigured')
    }
  })

  it('treats a NULL flag as required, which is what every call site assumed', () => {
    expect(resolveTabPinPolicy({ pin_required: null, tab_pin: '1234' }).mode).toBe('required')
    expect(resolveTabPinPolicy({ pin_required: null, tab_pin: null }).mode).toBe('misconfigured')
  })

  it('discloses only a real PIN, never a misconfigured one', () => {
    expect(tabPinIsDisclosable(resolveTabPinPolicy({ pin_required: true, tab_pin: '1234' }))).toBe(true)
    expect(tabPinIsDisclosable(resolveTabPinPolicy({ pin_required: true, tab_pin: null }))).toBe(false)
    expect(tabPinIsDisclosable(resolveTabPinPolicy({ pin_required: false, tab_pin: null }))).toBe(false)
  })
})
