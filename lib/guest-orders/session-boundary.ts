import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A SESSION ENDED BY CLOSE TABLE IS OVER. Nothing placed before it renders to a customer.
 *
 * ============================================================================================
 * THE DEFECT, measured on production 2026-08-18
 * ============================================================================================
 *
 * Clear the table, start a fresh customer session, order — and My Orders showed the new order AND
 * orders from before the close. The chain, measured rather than reasoned:
 *
 *   `close_table_session` settles the table's tabs, expires its `customer_sessions` rows, and
 *   bumps `restaurant_tables.current_session_version`. That boundary is real and
 *   `validateSessionToken` enforces it correctly — "Session version mismatch — table has been
 *   reset".
 *
 *   `app/api/guest/orders/by-session` NEVER CALLS IT. It scoped by `restaurant_id` + `session_id`
 *   and nothing else. `tabs/[tabId]/view` did not call it either.
 *
 *   And the phone keeps its `flashtap_session_v1` across the close, because the only thing that
 *   would clear it — `useSessionTokenGuard` — was imported by NO screen. The hook existed, was
 *   referenced in tests, and ran nowhere.
 *
 * So the same phone kept the same session id, asked "everything with this id", and the server had
 * no reason to refuse. The orders genuinely belong to that session id. The session id is what
 * should not have survived.
 *
 * THIS IS THE #302 CLASS: scoped by an identifier rather than by a session that is still valid.
 *
 * ============================================================================================
 * WHY THE BOUNDARY IS ENFORCED HERE, ON THE SERVER
 * ============================================================================================
 *
 * A boundary enforced only on the phone is not a boundary — a client guard that was written,
 * tested and never mounted is exactly how this reached production. The refusal happens here. Any
 * client-side eviction is a courtesy on top of it.
 *
 * ============================================================================================
 * WHAT THE SCHEMA ACTUALLY PERMITS, and why there is no migration
 * ============================================================================================
 *
 * `customer_sessions` cannot be joined to an order: it has no `session_id` column at all, only a
 * `token`. So "filter to rows whose session is still valid" was never available in that shape.
 *
 * What IS available, and is exact:
 *
 *   orders            carry `is_closed` / `table_closed`, already set by the close route and
 *                     already respected by lib/orders/active-order-visibility.ts — the My Orders
 *                     read simply never applied it. 2695 of 2702 production orders carry
 *                     `is_closed`.
 *   tabs              carry `session_version`. A close settles the tab and bumps the TABLE, so a
 *                     pre-close tab is left behind at the old version. Comparing the two is the
 *                     boundary the ruling names, and it needs no new column.
 *   order_requests    carry NEITHER marker. All 16 on production sit on a table that has been
 *                     closed at least once. They are bounded through their TAB.
 *
 * ============================================================================================
 * FAIL CLOSED, and what that costs
 * ============================================================================================
 *
 * A row that cannot be attributed to a still-current session does not render to a customer. That
 * includes a TAB-LESS request, which has no tab to carry a version and therefore cannot be placed
 * on either side of the boundary. Hiding one is the safe direction: the alternative is showing a
 * previous diner's order to whoever is sitting at that table now.
 *
 * NOTHING IS DELETED. This is a read filter. Every row remains for staff, on the settled tab, and
 * in every financial record — the pre-close orders are financial records and are untouched.
 */

export type BoundaryRow = Record<string, unknown>

/**
 * Rows whose session is still the table's current one.
 *
 * Two extra reads: the tabs referenced by the rows, and the tables those tabs belong to. Batched,
 * so it is two round trips regardless of row count.
 */
export async function filterToCurrentSession<T extends BoundaryRow>(
  supabase: SupabaseClient,
  rows: T[],
  opts: { surface: 'orders' | 'order_requests' },
): Promise<{ kept: T[]; droppedClosed: number; droppedStaleSession: number; droppedUnattributable: number }> {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) {
    return { kept: [], droppedClosed: 0, droppedStaleSession: 0, droppedUnattributable: 0 }
  }

  let droppedClosed = 0
  let droppedStaleSession = 0
  let droppedUnattributable = 0

  /**
   * ORDERS FIRST, on the marker that already exists. Cheap, needs no join, and covers the great
   * majority of production rows.
   */
  const afterClosed =
    opts.surface === 'orders'
      ? list.filter((r) => {
          const closed = r.is_closed === true || r.table_closed === true
          if (closed) droppedClosed += 1
          return !closed
        })
      : list

  const tabIds = [...new Set(afterClosed.map((r) => String(r.tab_id ?? '').trim()).filter(Boolean))]

  /**
   * A row with NO tab cannot be placed on either side of the boundary — there is nothing carrying
   * a version. An ORDER in that position has already passed the `table_closed` check above, which
   * is the marker its own table maintains, so it is kept. A REQUEST has no marker at all and is
   * dropped: fail closed.
   */
  const tabless = afterClosed.filter((r) => !String(r.tab_id ?? '').trim())
  if (opts.surface === 'order_requests') droppedUnattributable += tabless.length

  if (tabIds.length === 0) {
    const kept = opts.surface === 'orders' ? afterClosed : []
    return { kept, droppedClosed, droppedStaleSession, droppedUnattributable }
  }

  const { data: tabs } = await supabase
    .from('tabs')
    .select('id, table_id, session_version')
    .in('id', tabIds)

  const tableIds = [...new Set((tabs ?? []).map((t) => String(t.table_id ?? '')).filter(Boolean))]
  const currentByTable = new Map<string, unknown>()
  if (tableIds.length > 0) {
    const { data: tables } = await supabase
      .from('restaurant_tables')
      .select('id, current_session_version')
      .in('id', tableIds)
    for (const t of tables ?? []) currentByTable.set(String(t.id), t.current_session_version)
  }

  const tabById = new Map<string, { table_id: unknown; session_version: unknown }>()
  for (const t of tabs ?? []) tabById.set(String(t.id), t)

  const kept = afterClosed.filter((r) => {
    const tabId = String(r.tab_id ?? '').trim()
    if (!tabId) return opts.surface === 'orders'

    const tab = tabById.get(tabId)
    if (!tab) {
      // The tab the row points at does not exist. Unattributable; fail closed.
      droppedUnattributable += 1
      return false
    }
    const current = currentByTable.get(String(tab.table_id ?? ''))
    if (current == null) {
      /**
       * No table, or a table row we could not read. A tab that belongs to no table cannot be
       * bounded — but it also cannot have been closed by a table reset, so dropping it would hide
       * a live order for a schema shape rather than a session boundary. Kept, and counted.
       */
      return true
    }
    if (Number(tab.session_version) !== Number(current)) {
      droppedStaleSession += 1
      return false
    }
    return true
  })

  return { kept, droppedClosed, droppedStaleSession, droppedUnattributable }
}

/**
 * Is this tab still the table's current session? The same question, for a surface that already
 * knows which tab it is looking at — `tabs/[tabId]/view` and its siblings.
 *
 * Returns `false` when the tab or its table cannot be read, because a surface that cannot
 * establish the boundary must not serve across it.
 */
export async function tabIsCurrentSession(
  supabase: SupabaseClient,
  tabId: string,
): Promise<boolean> {
  const id = String(tabId ?? '').trim()
  if (!id) return false

  const { data: tab } = await supabase
    .from('tabs')
    .select('id, table_id, session_version')
    .eq('id', id)
    .maybeSingle()
  if (!tab) return false

  const tableId = String(tab.table_id ?? '').trim()
  // A tab with no table cannot have been reset by a table close. See the note above.
  if (!tableId) return true

  const { data: table } = await supabase
    .from('restaurant_tables')
    .select('current_session_version')
    .eq('id', tableId)
    .maybeSingle()
  if (!table) return false

  return Number(tab.session_version) === Number(table.current_session_version)
}
