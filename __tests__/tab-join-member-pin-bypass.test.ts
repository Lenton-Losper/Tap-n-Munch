/**
 * Issue #262 — POST /api/tabs/[tabId]/join skipped the PIN for anyone who could name a member's
 * session_id, and member session_ids are public.
 *
 * The route computed `alreadyMember` by matching a CLIENT-SUPPLIED `sessionId` against the tab's
 * `members[]` array, then used it to skip the PIN check entirely:
 *
 *     if (pinRequired && !alreadyMember) { ...require a matching PIN... }
 *
 * `tabs.members` is granted to the public `anon` role by
 * supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql, and the anon
 * SELECT policy carries no restaurant scope — so `select id,members` under the published anon key
 * returns every member entry of every open tab, `session_id` included. The single value that
 * satisfied the bypass was therefore obtainable by anyone holding the anon key, and the route
 * answered with a real, working session token for a stranger's tab.
 *
 * The fix is that `pinRequired` alone gates the PIN. `alreadyMember` survives because it still has
 * a legitimate job further down: it is what stops a rejoin from appending a duplicate entry to
 * `members[]`. Removing the bypass is not the same as removing the variable, and the controls
 * below assert that the append behaviour on both sides is unchanged.
 *
 * FAILS WITHOUT THE FIX: the first test gets 200 + a session token instead of 403.
 */
import { POST } from '@/app/api/tabs/[tabId]/join/route'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const TABLE_ID = 'table-uuid-1'
const REAL_PIN = '4821'

/** The member entry an attacker reads straight out of the public anon `select id,members`. */
const HARVESTED_SESSION_ID = 'sess-of-a-real-diner'

type TabRow = Record<string, unknown>

let tabRow: TabRow
/** Every `update()` payload the route wrote, so the append behaviour can be asserted. */
let updates: Array<Record<string, unknown>> = []
/** Set when the route issued a session token — the thing the bypass illegitimately handed out. */
let issuedToken: string | null = null

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => RESTAURANT_UUID,
}))

jest.mock('@/lib/session-token', () => ({
  issueTokenForOpenTab: async () => {
    issuedToken = 'session-token-value'
    return issuedToken
  },
}))

function makeClient() {
  return {
    from(table: string) {
      if (table !== 'tabs') throw new Error(`unexpected table: ${table}`)
      return {
        select() {
          const builder: Record<string, unknown> = {
            eq: () => builder,
            single: async () => ({ data: tabRow, error: null }),
          }
          return builder
        },
        update(row: Record<string, unknown>) {
          updates.push(row)
          const builder: Record<string, unknown> = {
            eq: () => builder,
            then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
          }
          return builder
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  updates = []
  issuedToken = null
  tabRow = {
    id: TAB_ID,
    restaurant_id: RESTAURANT_UUID,
    table_id: TABLE_ID,
    table_number: 7,
    status: 'open',
    pin_required: true,
    tab_pin: REAL_PIN,
    members: [
      { session_id: HARVESTED_SESSION_ID, joined_at: '2026-08-01T10:00:00.000Z', display_name: 'Person 1' },
    ],
  }
})

async function join(body: Record<string, unknown>) {
  const res = await POST(
    new Request(`https://example.test/api/tabs/${TAB_ID}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restaurantId: RESTAURANT_UUID, tableNumber: 7, ...body }),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) }
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/tabs/[tabId]/join — a known member session_id is not a credential (#262)', () => {
  it('refuses a PIN-less join that presents a session_id harvested from the public members[]', async () => {
    const { status, body } = await join({ sessionId: HARVESTED_SESSION_ID, displayName: 'Mallory' })

    // The harm is the token, not the status code: this response is what let a stranger read and
    // add to someone else's tab.
    expect(issuedToken).toBeNull()
    expect(body.sessionToken).toBeUndefined()
    expect(status).toBe(403)
    expect(String(body.error)).toMatch(/pin/i)
  })

  it('refuses a WRONG PIN from that same harvested session_id', async () => {
    const { status } = await join({ sessionId: HARVESTED_SESSION_ID, pin: '0000' })

    expect(issuedToken).toBeNull()
    expect(status).toBe(403)
  })

  it('still lets a genuine member rejoin WITH the PIN, and does not duplicate their members[] entry', async () => {
    const { status, body } = await join({ sessionId: HARVESTED_SESSION_ID, pin: REAL_PIN })

    expect(status).toBe(200)
    expect(body.sessionToken).toBe('session-token-value')
    // `alreadyMember` still does its real job: no second entry for a session already present.
    expect(updates).toEqual([])
  })

  it('still lets a NEW guest join with the PIN, appending exactly one members[] entry', async () => {
    const { status } = await join({ sessionId: 'sess-new-guest', displayName: 'Ada', pin: REAL_PIN })

    expect(status).toBe(200)
    expect(updates).toHaveLength(1)
    const members = updates[0].members as Array<{ session_id: string; display_name: string }>
    expect(members.map((m) => m.session_id)).toEqual([HARVESTED_SESSION_ID, 'sess-new-guest'])
    expect(members[1].display_name).toBe('Ada')
  })

  it('still lets anyone join a tab with no PIN set, member or not', async () => {
    tabRow.pin_required = false
    tabRow.tab_pin = null

    const { status } = await join({ sessionId: 'sess-new-guest', displayName: 'Ada' })

    expect(status).toBe(200)
    expect(updates).toHaveLength(1)
  })
})
