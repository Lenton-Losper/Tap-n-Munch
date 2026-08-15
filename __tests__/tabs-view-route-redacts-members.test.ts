/**
 * Issue #262 — GET /api/tabs/[tabId]/view is the redacting seam for the two guest screens that
 * genuinely need the members array, and GET /api/tabs/[tabId] is the session-token-guarded read
 * that used to return the row VERBATIM.
 *
 * `tabs.members` holds every diner's raw `session_id`, the anon SELECT grant covers it, and the
 * policy carries no restaurant scope — so the published anon key could enumerate the credential
 * that lib/guest-orders/queries.ts fetchGuestOrdersBySession reads a diner's orders by.
 *
 * contexts/tab-context.tsx loadTab and lib/tab-session.ts fetchTabById both need the array
 * (menu/[id]/tab and menu/[id]/receipt pair a member with that member's orders to print a
 * name), so the read moves here and the credential is swapped for an opaque per-tab key.
 *
 * Pinned below:
 *   1. no `session_id`, in any shape, ever leaves either route;
 *   2. the scoping filters both clients applied are reproduced exactly, including matching
 *      restaurant_id RAW — resolving a slug here would start returning rows where the client
 *      used to get none;
 *   3. `self_member_keys` is derived for the caller's own ids whether or not they are in
 *      members[], because the screens use it to recognise their own orders on a tab that has no
 *      members array at all;
 *   4. the seam's key equals the one lib/tab-member-key.ts derives, so the client-side join
 *      resolves.
 *
 * FAILS WITHOUT THE FIX: app/api/tabs/[tabId]/view/route.ts does not exist at 97e4fe1, and
 * app/api/tabs/[tabId]/route.ts returns `members` untouched.
 */
import { GET as VIEW } from '@/app/api/tabs/[tabId]/view/route'
import { GET as GUARDED } from '@/app/api/tabs/[tabId]/route'
import { deriveTabMemberKey } from '@/lib/tab-member-key'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_TAB_ID = '99999999-8888-7777-6666-555555555555'

const MY_SESSION = 'session_1754900000000_mine'
const OTHER_SESSION = 'sess-of-another-diner'

/** Exactly as the column stores it. `session_id` is the credential. */
const MEMBERS = [
  { session_id: MY_SESSION, joined_at: '2026-08-10T18:00:00.000Z', display_name: 'Ada' },
  { session_id: OTHER_SESSION, joined_at: '2026-08-10T18:05:00.000Z', display_name: 'Grace' },
]

type Filters = Array<[string, string, unknown]>

let tabFilters: Filters
let selected: string
let tabRow: Record<string, unknown> | null
/** The orders read added 2026-08-15 for the authoritative outstanding total. */
let orderFilters: Filters
let ordersSelected: string
let orderRows: Array<Record<string, unknown>>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    // Table-aware since 2026-08-15: the route now reads `orders` as well, to compute the
    // authoritative outstanding total. Recording both separately is what stops an assertion
    // about the tabs query silently passing against the orders one.
    from(table: string) {
      const isOrders = table === 'orders'
      return {
        select(columns: string) {
          if (isOrders) ordersSelected = columns
          else selected = columns
          const builder: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              ;(isOrders ? orderFilters : tabFilters).push(['eq', col, val])
              return builder
            },
            maybeSingle: async () => ({ data: tabRow, error: null }),
            // The orders read is awaited directly rather than via maybeSingle.
            then: (resolve: (v: unknown) => unknown) =>
              resolve({ data: isOrders ? orderRows : tabRow, error: null }),
          }
          return builder
        },
      }
    },
  }),
}))

/** The guarded route only; the seam is deliberately unauthenticated (see its header). */
jest.mock('@/lib/session-guard', () => ({
  requireSessionToken: async () => ({ tabId: '11111111-2222-3333-4444-555555555555' }),
}))

beforeEach(() => {
  tabFilters = []
  selected = ''
  orderFilters = []
  ordersSelected = ''
  orderRows = []
  tabRow = {
    id: TAB_ID,
    restaurant_id: RESTAURANT_UUID,
    table_id: 'table-uuid-1',
    table_number: 7,
    status: 'open',
    settled_type: null,
    total: 184.5,
    payment_preference: null,
    ready_to_pay_at: null,
    pin_required: true,
    session_version: 3,
    created_at: '2026-08-10T17:55:00.000Z',
    firebase_id: null,
    members: MEMBERS,
  }
})

async function callView(query: string) {
  const res = await VIEW(new Request(`https://example.test/api/tabs/${TAB_ID}/view?${query}`), {
    params: Promise.resolve({ tabId: TAB_ID }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

describe('GET /api/tabs/[tabId]/view — the redacting seam (#262)', () => {
  it('never lets a session_id out, in any shape', async () => {
    const { status, body } = await callView(`restaurantId=${RESTAURANT_UUID}`)

    expect(status).toBe(200)
    // The harm is a credential crossing the wire, so assert on the serialised body rather than
    // on which keys happen to be present.
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('session_id')
    expect(wire).not.toContain(MY_SESSION)
    expect(wire).not.toContain(OTHER_SESSION)
  })

  it('returns exactly display_name, joined_at and member_key per member', async () => {
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}`)

    expect(body.tab.members).toHaveLength(2)
    for (const member of body.tab.members) {
      expect(Object.keys(member).sort()).toEqual(['display_name', 'joined_at', 'member_key'])
      expect(member.member_key).toMatch(/^mk_[0-9a-f]{32}$/)
    }
    // The pairing is the reason the array survives at all.
    expect(body.tab.members.map((m: any) => m.display_name)).toEqual(['Ada', 'Grace'])
    expect(body.tab.members.map((m: any) => m.joined_at)).toEqual([
      '2026-08-10T18:00:00.000Z',
      '2026-08-10T18:05:00.000Z',
    ])
  })

  it('derives the same key the orders side derives, or the client join resolves nothing', async () => {
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}`)
    expect(body.tab.members[0].member_key).toBe(await deriveTabMemberKey(TAB_ID, MY_SESSION))
    expect(body.tab.members[1].member_key).toBe(await deriveTabMemberKey(TAB_ID, OTHER_SESSION))
  })

  it('keys are per tab — the same diner on another tab is a different member_key', async () => {
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}`)
    expect(body.tab.members[0].member_key).not.toBe(
      await deriveTabMemberKey(OTHER_TAB_ID, MY_SESSION),
    )
  })

  it('reproduces both client filters, matching restaurant_id RAW', async () => {
    await callView(`restaurantId=riviera-slug`)
    // Both callers pass the `restaurantId` path segment straight into .eq() today, so a slug
    // that never resolved returned no row and the screen redirected. Resolving it here would
    // start returning rows where the client used to get none.
    expect(tabFilters).toEqual([
      ['eq', 'id', TAB_ID],
      ['eq', 'restaurant_id', 'riviera-slug'],
    ])
  })

  /**
   * THE AUTHORITATIVE TAB TOTAL (RULED 2026-08-15). `tabs.total` is a display-only cache with two
   * live definitions; this seam is where every customer surface now gets the real figure, so the
   * shape of that answer is asserted here rather than only in the pure-function tests.
   */
  it('returns an outstanding_total computed from the orders, not the tabs.total cache', async () => {
    orderRows = [
      { total: 100, payment_status: 'pending' },
      { total: 150, payment_status: 'paid' },
      { total: 40, payment_status: 'cancelled' },
    ]
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}`)

    expect(body.tab.outstanding_total).toBe(100)
    // The cache is still returned for staff callers, and it must NOT be what the figure equals.
    expect(body.tab.total).not.toBe(body.tab.outstanding_total)
    expect(ordersSelected).toContain('payment_status')
    expect(ordersSelected).toContain('tab_settlement_for_tab_id')
    expect(orderFilters).toEqual([['eq', 'tab_id', TAB_ID]])
  })

  it('returns 0 for a tab with no orders — absence of debt, not absence of an answer', async () => {
    // A zero is a number a customer would believe. Absence has to be distinguishable.
    orderRows = []
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}`)
    // No orders is genuinely zero owed. The NULL case is a query ERROR, which this mock cannot
    // produce -- covered instead by the route reading `ordersError` before computing.
    expect(body.tab.outstanding_total).toBe(0)
  })

  it('asks PostgREST for members but is the only thing that ever sees them', async () => {
    await callView(`restaurantId=${RESTAURANT_UUID}`)
    // service_role, so naming the column is fine here and only here.
    expect(selected).toContain('members')
    expect(selected).toContain('pin_required')
    expect(selected).toContain('session_version')
  })

  it('marks the caller with self_member_keys, for every session id it was given', async () => {
    const { body } = await callView(
      `restaurantId=${RESTAURANT_UUID}&sessionId=${MY_SESSION}&sessionId=sess_other_storage`,
    )
    expect(body.self_member_keys).toEqual([
      await deriveTabMemberKey(TAB_ID, MY_SESSION),
      await deriveTabMemberKey(TAB_ID, 'sess_other_storage'),
    ])
    // The first one identifies the caller's own member row.
    expect(body.self_member_keys).toContain(body.tab.members[0].member_key)
  })

  it('derives self keys even for a session id that is in no member row', async () => {
    tabRow!.members = []
    const { body } = await callView(`restaurantId=${RESTAURANT_UUID}&sessionId=${MY_SESSION}`)
    // menu/[id]/tab falls back to grouping orders when the members array is empty, and those
    // orders arrive with member_session_id already mapped. Limiting this to ids that matched a
    // member row would leave the caller unable to recognise their own lines.
    expect(body.self_member_keys).toEqual([await deriveTabMemberKey(TAB_ID, MY_SESSION)])
    expect(body.tab.members).toEqual([])
  })

  it('returns { tab: null } for a tab the filters do not match', async () => {
    tabRow = null
    const { status, body } = await callView(`restaurantId=${RESTAURANT_UUID}`)
    expect(status).toBe(200)
    expect(body.tab).toBeNull()
    expect(body.self_member_keys).toEqual([])
  })

  it('rejects a call with no restaurantId rather than reading a tab unscoped', async () => {
    const { status } = await callView('')
    expect(status).toBe(400)
  })
})

describe('GET /api/tabs/[tabId] — the zero-caller route that returned the row verbatim (#262)', () => {
  it('no longer hands a session token holder every other diner’s session_id', async () => {
    const res = await GUARDED(new Request(`https://example.test/api/tabs/${TAB_ID}`), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    const body = (await res.json()) as Record<string, any>

    expect(res.status).toBe(200)
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('session_id')
    expect(wire).not.toContain(OTHER_SESSION)
    // One member of a shared tab could otherwise have read every other member's orders.
    expect(body.tab.members[0].member_key).toBe(await deriveTabMemberKey(TAB_ID, MY_SESSION))
    // The rest of the projection is untouched, so this is a redaction and not a rewrite.
    expect(body.tab.id).toBe(TAB_ID)
    expect(body.tab.session_version).toBe(3)
    expect(body.tab.total).toBe(184.5)
  })
})
