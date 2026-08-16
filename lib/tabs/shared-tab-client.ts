/**
 * Client side of GET /api/tabs/[tabId]/orders — the shared Tab.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: there is no fallback to the session-scoped list.
 *
 * `/menu/[id]/tab` previously built its groups from `fetchOrdersForTab`, which is scoped to the
 * ids THIS BROWSER holds. Keeping that as a fallback would be the most tempting change in this
 * piece and the worst one: when the shared read failed, the screen would quietly show one
 * diner's food under a whole table's heading, which is exactly the defect being fixed and would
 * be invisible precisely when it was wrong. The human's standing ruling is "fix the writer, never
 * add a fallback that hides its absence", so a failure returns `null` and the screen says the
 * table's orders could not be loaded.
 *
 * The two figures are NOT read from here in that case: they come from the tab record
 * (`payable_total` / `pending_total`), which is a separate, still-working read. So a failed
 * shared read costs the LIST, not the money.
 */
import { fetchWithSession } from '@/lib/fetch-with-session'
import type { TabMemberGroup } from '@/lib/tabs/tab-order-groups'

export type SharedTabResponse = {
  tab_id: string
  tab_status: string
  members: TabMemberGroup[]
  /** Non-null only when orders on the tab could not be attributed to a member. A finding. */
  unattributed: TabMemberGroup | null
  totals: { payable: number | null; pending: number | null }
}

/**
 * @returns the shared tab, or `null` if it could not be read. `null` is not "empty" — an empty
 *          tab returns a response with `members: []`. Callers must render the two states
 *          differently.
 */
export async function fetchSharedTab(args: {
  tabId: string
  restaurantId: string
  /** Every session id this browser holds. Used only to mark `is_self` on the response. */
  sessionIds: string[]
}): Promise<SharedTabResponse | null> {
  const tabId = String(args.tabId || '').trim()
  const restaurantId = String(args.restaurantId || '').trim()
  if (!tabId || !restaurantId) return null

  const query = new URLSearchParams()
  query.set('restaurantId', restaurantId)
  // Repeated params, not comma-joined: the app mints two ids in two storages (#278).
  for (const sessionId of [...new Set(args.sessionIds.map((s) => String(s || '').trim()))]) {
    if (sessionId) query.append('sessionId', sessionId)
  }

  try {
    const res = await fetchWithSession(
      `/api/tabs/${encodeURIComponent(tabId)}/orders?${query.toString()}`,
      restaurantId
    )
    // 410 is already handled inside fetchWithSession, which redirects to the landing.
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as SharedTabResponse | null
    if (!data || !Array.isArray(data.members)) return null
    return data
  } catch {
    return null
  }
}
