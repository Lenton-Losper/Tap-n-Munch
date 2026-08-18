/**
 * A SESSION ENDED BY CLOSE TABLE IS OVER.
 *
 * Measured on production 2026-08-18: clear the table, start a fresh customer session, order — and
 * My Orders showed the new order AND orders from before the close. `close_table_session` settles
 * the tabs and bumps `restaurant_tables.current_session_version`; `validateSessionToken` enforces
 * that boundary correctly and the guest reads never called it.
 *
 * These pin the SERVER filter. Whether a customer's screen ends up with exactly one order is
 * asserted in a browser; this is the rule the browser test rests on.
 */
import { filterToCurrentSession, tabIsCurrentSession } from '@/lib/guest-orders/session-boundary'

type Row = Record<string, unknown>

/**
 * A Supabase stub over fixed tabs/tables. Only the two tables the filter reads are modelled —
 * anything else would be inventing behaviour the function does not use.
 */
function stubDb(tabs: Row[], tables: Row[]) {
  const rowsFor = (table: string) => (table === 'tabs' ? tabs : tables)
  const client = {
    from(table: string) {
      return {
        select: () => ({
          in: async (_col: string, ids: string[]) => ({
            data: rowsFor(table).filter((r) => ids.includes(String(r.id))),
            error: null,
          }),
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({
              data: rowsFor(table).find((r) => String(r.id) === String(id)) ?? null,
              error: null,
            }),
          }),
        }),
      }
    },
  }
  return client as never
}

const TABLE = { id: 'table-1', current_session_version: 4 }
const CURRENT_TAB = { id: 'tab-now', table_id: 'table-1', session_version: 4 }
const OLD_TAB = { id: 'tab-old', table_id: 'table-1', session_version: 3 }

describe('filterToCurrentSession — orders', () => {
  it('drops an order whose table was closed, on the marker that already existed', async () => {
    // `orders.table_closed` is set by the close route and already respected by
    // active-order-visibility. The My Orders read simply never applied it. 2695 of 2702 production
    // orders carry `is_closed`.
    const rows: Row[] = [
      { id: 'a', tab_id: 'tab-now', table_closed: true },
      { id: 'b', tab_id: 'tab-now', is_closed: true },
      { id: 'c', tab_id: 'tab-now' },
    ]
    const r = await filterToCurrentSession(stubDb([CURRENT_TAB], [TABLE]), rows, {
      surface: 'orders',
    })
    expect(r.kept.map((x) => x.id)).toEqual(['c'])
    expect(r.droppedClosed).toBe(2)
  })

  it('drops an order on a tab left behind at an older session version', async () => {
    const rows: Row[] = [
      { id: 'before', tab_id: 'tab-old' },
      { id: 'after', tab_id: 'tab-now' },
    ]
    const r = await filterToCurrentSession(stubDb([OLD_TAB, CURRENT_TAB], [TABLE]), rows, {
      surface: 'orders',
    })
    expect(r.kept.map((x) => x.id)).toEqual(['after'])
    expect(r.droppedStaleSession).toBe(1)
  })

  /**
   * THE POSITIVE CONTROL FOR THE WHOLE FILTER. Everything above is a drop; a filter that dropped
   * EVERYTHING would satisfy all of it. The current session's own orders must survive.
   */
  it('keeps the current session’s orders — it is a boundary, not a blanket', async () => {
    const rows: Row[] = [
      { id: 'x', tab_id: 'tab-now' },
      { id: 'y', tab_id: 'tab-now' },
    ]
    const r = await filterToCurrentSession(stubDb([CURRENT_TAB], [TABLE]), rows, {
      surface: 'orders',
    })
    expect(r.kept.map((x) => x.id)).toEqual(['x', 'y'])
    expect(r.droppedClosed + r.droppedStaleSession + r.droppedUnattributable).toBe(0)
  })

  it('keeps a TAB-LESS order, which its own table_closed marker already bounds', async () => {
    const rows: Row[] = [{ id: 'solo' }]
    const r = await filterToCurrentSession(stubDb([], []), rows, { surface: 'orders' })
    expect(r.kept.map((x) => x.id)).toEqual(['solo'])
  })
})

describe('filterToCurrentSession — order_requests', () => {
  it('drops a request on a tab from a previous session', async () => {
    const rows: Row[] = [
      { id: 'declined-before', tab_id: 'tab-old', status: 'declined' },
      { id: 'now', tab_id: 'tab-now', status: 'waiting_review' },
    ]
    const r = await filterToCurrentSession(stubDb([OLD_TAB, CURRENT_TAB], [TABLE]), rows, {
      surface: 'order_requests',
    })
    expect(r.kept.map((x) => x.id)).toEqual(['now'])
    expect(r.droppedStaleSession).toBe(1)
  })

  /**
   * FAIL CLOSED, and it costs something. A request carries NEITHER `table_closed` NOR `is_closed`,
   * so one with no tab cannot be placed on either side of the boundary. Hiding it is the safe
   * direction: the alternative is showing a previous diner's order to whoever is at the table now.
   */
  it('drops a TAB-LESS request, because nothing can attribute it to a session', async () => {
    const rows: Row[] = [{ id: 'orphan', status: 'declined' }]
    const r = await filterToCurrentSession(stubDb([], []), rows, { surface: 'order_requests' })
    expect(r.kept).toEqual([])
    expect(r.droppedUnattributable).toBe(1)
  })

  it('drops a request pointing at a tab that no longer exists', async () => {
    const rows: Row[] = [{ id: 'dangling', tab_id: 'tab-gone' }]
    const r = await filterToCurrentSession(stubDb([CURRENT_TAB], [TABLE]), rows, {
      surface: 'order_requests',
    })
    expect(r.kept).toEqual([])
    expect(r.droppedUnattributable).toBe(1)
  })

  it('keeps the current session’s requests', async () => {
    const rows: Row[] = [{ id: 'live', tab_id: 'tab-now', status: 'waiting_review' }]
    const r = await filterToCurrentSession(stubDb([CURRENT_TAB], [TABLE]), rows, {
      surface: 'order_requests',
    })
    expect(r.kept.map((x) => x.id)).toEqual(['live'])
  })
})

describe('tabIsCurrentSession', () => {
  it('is true for the table’s current tab and false for the one it replaced', async () => {
    const db = stubDb([CURRENT_TAB, OLD_TAB], [TABLE])
    expect(await tabIsCurrentSession(db, 'tab-now')).toBe(true)
    expect(await tabIsCurrentSession(db, 'tab-old')).toBe(false)
  })

  it('refuses when the tab or its table cannot be read — a surface that cannot establish the boundary must not serve across it', async () => {
    expect(await tabIsCurrentSession(stubDb([], []), 'tab-now')).toBe(false)
    expect(await tabIsCurrentSession(stubDb([CURRENT_TAB], []), 'tab-now')).toBe(false)
    expect(await tabIsCurrentSession(stubDb([CURRENT_TAB], [TABLE]), '')).toBe(false)
  })
})
