/**
 * The tab PIN is released by GET /api/tabs/[tabId], and by nothing else.
 *
 * WHY THIS EXISTS. The PIN moved from "shown once at creation, on the creator's device only"
 * to "shown persistently to every member", because a customer who JOINED a tab had no way to
 * see the PIN they had just typed — which is most of why #265 (staff-driven PIN recovery)
 * exists at all. The disclosure is defensible only because of WHAT it is gated on: a session
 * token for THIS tab, which is strictly stronger than the PIN (the PIN's only power is to mint
 * such a token via POST /api/tabs/[tabId]/join, and the caller already holds one). Weaken the
 * gate and that argument collapses into "the PIN is readable by whoever has the tab UUID",
 * which is the exact thing the PIN guards against.
 *
 * So the assertions below are about the GATE, not the happy path. A test that only proved the
 * PIN comes back for a valid caller would pass just as well against a route that returned it
 * to everyone.
 *
 * THE STRICTER PREDICATE. The route's own 403 is `guard.tabId && guard.tabId !== tabId`, which
 * passes a token whose tabId is ABSENT. That cannot happen today — validateSessionToken joins
 * `tabs!inner`, so a valid token always carries a tab — but "cannot happen today" is not the
 * standard a credential should be released under, so disclosure requires a non-empty tabId
 * that matches. The `token carries no tab id` case below pins that, and it is the one that
 * would silently regress if someone later simplified the predicate to reuse the 403's.
 *
 * FAILS WITHOUT THE FIX: at 16298ed the route does not select `tab_pin` at all.
 */
import { GET } from '@/app/api/tabs/[tabId]/route'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_TAB_ID = '99999999-8888-7777-6666-555555555555'
const PIN = '4821'

/** Swapped per test to stand in for the token the caller presented. */
let guardResult: Record<string, unknown>
let tabRow: Record<string, unknown> | null

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from() {
      return {
        select() {
          const builder: Record<string, unknown> = {
            eq: () => builder,
            maybeSingle: async () => ({ data: tabRow, error: null }),
          }
          return builder
        },
      }
    },
  }),
}))

jest.mock('@/lib/session-guard', () => ({
  requireSessionToken: async () => guardResult,
}))

/*
 * Stubbed only because the real one reads the service-role secret from the environment, which a
 * unit run does not have. Its OWN contract — that a raw session_id never survives the swap — is
 * pinned by __tests__/tabs-view-route-redacts-members.test.ts against the real implementation.
 * The stub deliberately drops session_id too, so the #262 assertion at the bottom is still a
 * real check of this route's projection rather than an artefact of the mock.
 */
jest.mock('@/lib/tab-member-key', () => ({
  redactTabMembers: async (_tabId: string, members: unknown) =>
    (Array.isArray(members) ? members : []).map((m: Record<string, unknown>) => ({
      display_name: m.display_name,
      joined_at: m.joined_at,
      member_key: 'mk_00000000000000000000000000000000',
    })),
}))

beforeEach(() => {
  guardResult = { tabId: TAB_ID }
  tabRow = {
    id: TAB_ID,
    restaurant_id: RESTAURANT_UUID,
    table_id: 'table-uuid-1',
    table_number: 7,
    status: 'open',
    total: 184.5,
    session_version: 3,
    pin_required: true,
    tab_pin: PIN,
    members: [
      { session_id: 'sess-a', joined_at: '2026-08-10T18:00:00.000Z', display_name: 'Ada' },
    ],
  }
})

async function call(tabId = TAB_ID) {
  const res = await GET(new Request(`https://example.test/api/tabs/${tabId}`), {
    params: Promise.resolve({ tabId }),
  })
  const body = (await res.json()) as Record<string, any>
  return { status: res.status, body, wire: JSON.stringify(body) }
}

describe('GET /api/tabs/[tabId] — who may read the tab PIN', () => {
  it('gives the PIN to a holder of a token for THIS tab', async () => {
    const { status, body } = await call()

    expect(status).toBe(200)
    expect(body.tab.tab_pin).toBe(PIN)
  })

  it('refuses a token minted for a DIFFERENT tab, and leaks no PIN doing so', async () => {
    guardResult = { tabId: OTHER_TAB_ID }

    const { status, wire } = await call()

    expect(status).toBe(403)
    // Assert on the serialised body, not on a key name: the harm is the digits crossing the
    // wire, in whatever shape.
    expect(wire).not.toContain(PIN)
  })

  it('refuses when there is no valid token at all', async () => {
    const { NextResponse } = jest.requireActual('next/server')
    guardResult = {
      error: NextResponse.json({ error: 'Session token required.' }, { status: 410 }),
    }

    const { status, wire } = await call()

    expect(status).toBe(410)
    expect(wire).not.toContain(PIN)
  })

  it('withholds the PIN when the token carries no tab id, rather than trusting the 403 above', async () => {
    // The route's 403 does NOT fire here (`guard.tabId` is falsy), so the request reaches the
    // body. Disclosure must still refuse — this is the case the stricter predicate exists for.
    guardResult = {}

    const { status, body, wire } = await call()

    expect(status).toBe(200)
    expect(body.tab.tab_pin).toBeUndefined()
    expect(wire).not.toContain(PIN)
  })

  it('withholds the PIN when the restaurant has turned PINs off', async () => {
    tabRow = { ...(tabRow as object), pin_required: false }

    const { body, wire } = await call()

    expect(body.tab.tab_pin).toBeUndefined()
    expect(wire).not.toContain(PIN)
  })

  it('withholds the PIN when the tab simply has none', async () => {
    tabRow = { ...(tabRow as object), tab_pin: null }

    const { body } = await call()

    expect(body.tab.tab_pin).toBeUndefined()
  })

  it('still never lets a raw session_id out, PIN change or not (#262)', async () => {
    const { wire } = await call()

    expect(wire).not.toContain('session_id')
    expect(wire).not.toContain('sess-a')
  })
})
