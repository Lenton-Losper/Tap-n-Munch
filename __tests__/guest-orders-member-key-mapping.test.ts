/**
 * Issue #262 — the ORDER side of the member-key mapping.
 *
 * Redacting `tabs.members` alone is not enough. app/menu/[restaurantId]/tab/page.tsx and
 * app/menu/[restaurantId]/receipt/page.tsx print a diner's name against that diner's lines by
 * joining `orders.member_session_id` to the members array. If the members array carries an
 * opaque `member_key` and the orders still carry a raw session id, the join matches nothing and
 * BOTH screens fall back to labelling every line "Guest" — silently, with nothing failing.
 *
 * So lib/guest-orders/queries.ts applies the SAME derivation on the way out. Read-time only:
 * the stored column keeps the real id, which is what staff tooling, the Accept path and the
 * settle path read.
 *
 * FAILS WITHOUT THE FIX: at 97e4fe1 these rows come back with their raw session ids.
 */
import { deriveTabMemberKey } from '@/lib/tab-member-key'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const MY_SESSION = 'session_1754900000000_mine'

let orderRows: Array<Record<string, unknown>>
let requestRows: Array<Record<string, unknown>>

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
        /**
         * THE SESSION BOUNDARY, added 2026-08-18. fetchGuestOrdersBySession now reads `tabs` and
         * `restaurant_tables` and AWAITS `.in(...)` directly. This stub's `in()` returned the
         * non-thenable builder, so both reads resolved to undefined, no tab was found, and every
         * row was dropped as unattributable — the suite correctly noticing a behaviour change.
         *
         * The fixture tab sits AT the table's current version, so these tests go on exercising
         * the member-key mapping they are about.
         */
        if (table === 'tabs' || table === 'restaurant_tables') {
          const rows =
            table === 'tabs'
              ? [{ id: TAB_ID, table_id: 'table-1', session_version: 1 }]
              : [{ id: 'table-1', current_session_version: 1 }]
          return { select: () => ({ in: async () => ({ data: rows, error: null }) }) }
        }
      return {
        select() {
          const builder: Record<string, unknown> = {
            eq: () => builder,
            in: () => builder,
            is: () => builder,
            gte: () => builder,
            lt: () => builder,
            order: async () => ({
              data: table === 'orders' ? orderRows : requestRows,
              error: null,
            }),
          }
          return builder
        },
      }
    },
  }),
}))

const { fetchGuestOrdersBySession } = require('@/lib/guest-orders/queries')

beforeEach(() => {
  requestRows = []
  orderRows = [
    {
      id: 'order-1',
      tab_id: TAB_ID,
      session_id: MY_SESSION,
      member_session_id: MY_SESSION,
      total: 84.5,
      placed_at: '2026-08-10T18:10:00.000Z',
    },
  ]
})

describe('guest orders carry member_key, not a session id (#262)', () => {
  it('maps member_session_id through the same per-tab derivation the seam uses', async () => {
    const { orders } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT_UUID,
      sessionId: MY_SESSION,
      tabId: TAB_ID,
    })

    expect(orders).toHaveLength(1)
    // This equality is what makes the client-side join resolve. GET /api/tabs/[tabId]/view puts
    // exactly this value in members[].member_key.
    expect(orders[0].member_session_id).toBe(await deriveTabMemberKey(TAB_ID, MY_SESSION))
    expect(orders[0].member_session_id).not.toBe(MY_SESSION)
  })

  it('falls back to session_id for orders placed before member_session_id existed', async () => {
    orderRows[0].member_session_id = null

    const { orders } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT_UUID,
      sessionId: MY_SESSION,
      tabId: TAB_ID,
    })

    // Both screens read `o.member_session_id || o.session_id`; leaving a null row alone would
    // drop exactly those orders out of their member's group.
    expect(orders[0].member_session_id).toBe(await deriveTabMemberKey(TAB_ID, MY_SESSION))
  })

  it('leaves an order with no tab alone — there is no per-tab key to derive', async () => {
    orderRows[0].tab_id = null

    const { orders } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT_UUID,
      sessionId: MY_SESSION,
    })

    expect(orders[0].member_session_id).toBe(MY_SESSION)
  })

  it('does not disturb the rest of the row', async () => {
    const { orders, count } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT_UUID,
      sessionId: MY_SESSION,
      tabId: TAB_ID,
    })

    expect(count).toBe(1)
    expect(orders[0].id).toBe('order-1')
    expect(orders[0].total).toBe(84.5)
    expect(orders[0].tab_id).toBe(TAB_ID)
    // The caller's OWN session id is not redacted: they already hold it, it is how they asked
    // for these rows in the first place, and lib/guest-orders/validation.ts gates on it.
    expect(orders[0].session_id).toBe(MY_SESSION)
  })
})
