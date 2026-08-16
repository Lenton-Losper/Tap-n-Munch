/**
 * The shared Tab: everyone's orders on one table, grouped by the person who placed them.
 *
 * Redesign spec sections 24-26. This is the half of the Tab that did not exist.
 *
 * WHAT WAS ACTUALLY WRONG, measured rather than assumed. `/menu/[id]/tab` already grouped by
 * member and already rendered a server-derived table total. But the ORDER LIST it grouped came
 * from `fetchOrdersForTab`, which calls `fetchGuestOrdersBySession` with the ids THIS BROWSER
 * holds. So on a shared table Lenton saw "Lenton — Burger N$95" and a table total of N$115, and
 * Bob's Sprite appeared nowhere. The grouping was real and the data behind it was one person's.
 * A screen headed with the whole table's money and listing one diner's food is a worse lie than
 * either half alone, because the difference reads as a rounding error rather than as absence.
 *
 * WHY THE COMPUTATION IS HERE AND NOT ON THE CLIENT.
 *
 *   - The client cannot derive a `member_key` — that is the entire point of lib/tab-member-key.ts
 *     — so it cannot pair another diner's order with another diner's name.
 *   - Every money figure a customer sees must come from the server (ruled 2026-08-15). Summing
 *     lines in the browser is what produced #119/QRA-12.
 *   - The rows carry `session_id`, `member_session_id` and `edit_lock_token`, none of which may
 *     reach another diner. Building the response server-side means the raw row never leaves.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   - It grants NO mutation. Spec section 25: visibility and edit ownership are different
 *     things. Nothing here is an authorisation decision; the edit affordance stays gated on
 *     `ownsOrder` against the ids the browser itself holds, and the edit route's own check is
 *     unchanged. `is_self` is a rendering hint, never a permission.
 *   - It NEVER INFERS A RELATIONSHIP. An order on the tab whose member cannot be resolved goes
 *     to `unattributed` and is named as such. Attributing it to the caller, or to the first
 *     member, or dropping it, would each make the screen add up while being wrong — and the
 *     dropping variant would understate what the table has ordered.
 *   - It does not re-derive settleability. `computeTabFigures` is imported, so this cannot
 *     disagree with the figure the Ready-to-Pay button decides on.
 */
import { effectiveRequestPricing } from '@/lib/orders/order-request-pricing'

/** One line of food, as another diner at the same table is allowed to see it. */
export type TabGroupLine = {
  /** Menu item name as stored on the order. */
  name: string
  quantity: number
  /** Line total, as stored. Never recomputed here. */
  subtotal: number
}

/**
 * One order, as another diner is allowed to see it.
 *
 * `id` is present because the CALLER'S OWN card needs it to open the editor. It is not a
 * capability: the edit route authorises on session id against `session_id` / `member_session_id`
 * and returns 404 to a non-owner, so knowing another diner's order id grants nothing. It is
 * emitted for every order rather than only the caller's so the two lists cannot diverge; if that
 * ever stops being true, the fix is in the edit route, not here.
 */
export type TabGroupOrder = {
  id: string
  /** 'orders' or 'order_requests' — which table the row came from. */
  surface: 'orders' | 'order_requests'
  /** Raw backend status. Mapped to customer words at the render site, not here. */
  status: string
  /** null while the order is still a request: no number is allocated until Accept. */
  order_number: number | null
  /** Order total as stored (orders) or as resolved by precedence (requests). */
  total: number
  /** True when this order is money the restaurant has not yet agreed to. */
  is_pending: boolean
  lines: TabGroupLine[]
}

export type TabMemberGroup = {
  /** Opaque per-tab key. Never a session id. */
  member_key: string
  display_name: string
  /** A rendering hint for "you", derived from the caller's own token. NOT a permission. */
  is_self: boolean
  /** Accepted and unpaid, for this member. Server-computed. */
  payable: number
  /** Submitted and unanswered, for this member. Server-computed. */
  pending: number
  orders: TabGroupOrder[]
}

export type TabOrderGroups = {
  members: TabMemberGroup[]
  /**
   * Orders on this tab that could not be attributed to a member.
   *
   * Never merged into a member and never dropped. An empty array is the expected state; a
   * non-empty one is a FINDING about the data, and the screen says so rather than quietly
   * absorbing the money into someone's subtotal.
   */
  unattributed: TabMemberGroup
}

type RawOrderRow = Record<string, unknown>

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** The lines of an order, from whichever items array applies. Names and quantities only. */
function toLines(items: unknown): TabGroupLine[] {
  if (!Array.isArray(items)) return []
  return items.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>
    return {
      name: str(item.display_name) || str(item.name) || 'Item',
      quantity: num(item.quantity) || 1,
      subtotal: num(item.subtotal),
    }
  })
}

/**
 * The key an order should be filed under.
 *
 * `member_session_id` first, falling back to `session_id` — the same precedence
 * `redactGuestOrderMemberIds` and `/menu/[id]/tab` already apply, kept identical so a row files
 * under the key the members array will be looked up by. Restating it differently here is the
 * #278 class of bug: one predicate, several private copies.
 */
export function orderMemberSessionId(row: RawOrderRow): string {
  return str(row.member_session_id) || str(row.session_id)
}

export type BuildTabOrderGroupsInput = {
  /** `tabs.members`, already redacted to `{ display_name, member_key }`. */
  members: Array<{ member_key: string; display_name: string }>
  /** Member keys belonging to the CALLER. Rendering only. */
  selfMemberKeys: string[]
  /** `orders` rows on this tab, with their member session id ALREADY derived to a member_key. */
  orders: RawOrderRow[]
  /** `order_requests` rows on this tab, pending only, member session id already derived. */
  requests: RawOrderRow[]
  /** Predicate for "this order still owes money". Imported by the caller, never restated here. */
  owesMoney: (paymentStatus: unknown) => boolean
  /** Predicate for "this row is a settlement artefact, not a diner's food". */
  isSettlementArtefact?: (row: RawOrderRow) => boolean
}

export function buildTabOrderGroups(input: BuildTabOrderGroupsInput): TabOrderGroups {
  const selfKeys = new Set(input.selfMemberKeys.filter(Boolean))

  const emptyGroup = (member_key: string, display_name: string): TabMemberGroup => ({
    member_key,
    display_name,
    is_self: selfKeys.has(member_key),
    payable: 0,
    pending: 0,
    orders: [],
  })

  const byKey = new Map<string, TabMemberGroup>()
  for (const member of input.members) {
    const key = str(member.member_key)
    if (!key) continue
    byKey.set(key, emptyGroup(key, str(member.display_name) || 'Guest'))
  }

  const unattributed = emptyGroup('', '')

  /**
   * A member row exists for a key we have not seen: file it under a group of its own rather than
   * under `unattributed`. It IS attributed — to somebody who left the members array, or who
   * placed an order before joining — and calling that "unattributed" would lose the fact that
   * these lines belong together.
   */
  const groupFor = (memberKey: string): TabMemberGroup => {
    if (!memberKey) return unattributed
    let group = byKey.get(memberKey)
    if (!group) {
      group = emptyGroup(memberKey, 'Guest')
      byKey.set(memberKey, group)
    }
    return group
  }

  for (const row of input.orders) {
    if (input.isSettlementArtefact?.(row)) continue
    const group = groupFor(str(row.member_session_id))
    const total = num(row.total)
    group.orders.push({
      id: str(row.id),
      surface: 'orders',
      status: str(row.status),
      order_number: Number.isFinite(Number(row.order_number)) ? Number(row.order_number) : null,
      total,
      is_pending: false,
      lines: toLines(row.items),
    })
    // Paid orders stay VISIBLE — spec section 29 wants a partially settled tab to read as one —
    // but only unpaid ones add to what is owed.
    if (input.owesMoney(row.payment_status)) group.payable += total
  }

  for (const row of input.requests) {
    const group = groupFor(str(row.member_session_id))
    // reviewed ?? customer ?? original, in the one place that resolves it. Pricing a pending
    // request from the raw `total` would show a figure a staff review has already moved.
    const pricing = effectiveRequestPricing(row as never)
    group.orders.push({
      id: str(row.id),
      surface: 'order_requests',
      status: str(row.status),
      order_number: null,
      total: pricing.total,
      is_pending: true,
      lines: toLines(pricing.items),
    })
    group.pending += pricing.total
  }

  /** Members with nothing on the tab are dropped: a name with no food is noise on a bill. */
  const members = [...byKey.values()].filter((group) => group.orders.length > 0)

  return { members, unattributed }
}
