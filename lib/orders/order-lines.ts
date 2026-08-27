/**
 * ADR-005 §1 and §2 -- turning an order's items into fulfilment lines.
 *
 * ============================================================================================
 * WHY THIS DOES NOT USE normalizeRouteTo / enrichOrderItemsWithRouteTo
 * ============================================================================================
 *
 * `lib/order-routing.ts` already resolves route_to, and it is deliberately NOT reused here.
 *
 * `normalizeRouteTo` coerces null, undefined, '' and every unrecognised value to 'kitchen':
 *
 *     String(value || 'kitchen')  ->  'kitchen'
 *
 * and `enrichOrderItemsWithRouteTo` does the same at every failure edge -- no menu item ids, a
 * failed menu_items read, a failed menu_categories read, a menu item whose category is missing.
 *
 * For the ORDER ITEM that is fine and long-standing: `orderMatchesStation` uses it to decide
 * whether a whole order is interesting to a station, and guessing kitchen there is a display
 * heuristic on data nobody promised.
 *
 * For a LINE it is forbidden. ADR-005 §2, ruled: route_to is not trusted, it is not silently
 * corrected, and a line that cannot be routed becomes 'unrouted' and shows on BOTH screens under
 * a visible heading. Production holds 4 items with a null route_to today. Under the existing
 * helper all 4 would land silently in the kitchen; under this one they land visibly in front of
 * both stations, and somebody asks why -- which is the entire point. A silent default is food
 * nobody sees.
 *
 * So the two coexist on purpose. Changing `normalizeRouteTo` to match this would alter what the
 * POS and the existing station filters do to live orders, which is not in scope and was not ruled.
 *
 * ============================================================================================
 * 'both' FANS OUT, WHICH IS WHY LINES CARRY NO MONEY
 * ============================================================================================
 *
 * One item routed 'both' produces TWO lines -- one kitchen, one bar -- with independent state, so
 * each station bumps its own without touching the other. Both lines carry the SAME
 * source_item_index, because they came from one billed item.
 *
 * That is exactly why `order_lines` has no price column and why nothing here computes one.
 * Summing lines for money would double-charge every 'both' item, and production holds 1,274.
 */

export type LineStation = 'kitchen' | 'bar' | 'unrouted'

/** Raw category route_to values we recognise. Anything else is unroutable, not kitchen. */
const ROUTE_KITCHEN = 'kitchen'
const ROUTE_BAR = 'bar'
const ROUTE_BOTH = 'both'

/**
 * The fan-out. Deliberately total: every input maps to at least one station, and the fallback
 * is 'unrouted' rather than 'kitchen'.
 *
 * An unrecognised STRING is treated exactly like null. A category whose route_to says 'grill'
 * is not a kitchen item we happen to have spelled oddly -- it is a value this code has never
 * heard of, and pretending to understand it is the silent correction the ruling forbids.
 */
export function stationsForRouteTo(routeTo: unknown): LineStation[] {
  const value = typeof routeTo === 'string' ? routeTo.trim().toLowerCase() : ''
  if (value === ROUTE_KITCHEN) return ['kitchen']
  if (value === ROUTE_BAR) return ['bar']
  if (value === ROUTE_BOTH) return ['kitchen', 'bar']
  return ['unrouted']
}

type OrderItemish = Record<string, unknown>

function readMenuItemId(item: OrderItemish): string {
  return String(item.menuItemId || item.menu_item_id || '').trim()
}

/**
 * The per-line note -- "medium", "well done".
 *
 * Several key spellings are accepted because the cart, the kiosk and the terminal have each
 * grown their own, and a note that silently fails to reach the kitchen is worse than no note
 * feature at all. The terminal brief names `note` as the one to send.
 */
function readLineNote(item: OrderItemish): string | null {
  const candidates = [
    item.note,
    item.notes,
    item.lineNote,
    item.line_note,
    item.specialInstructions,
    item.special_instructions,
    item.instructions,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function readQuantity(item: OrderItemish): number {
  const raw = Number(item.quantity ?? item.qty ?? 1)
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

function readName(item: OrderItemish): string {
  const name = String(item.name || item.itemName || item.item_name || '').trim()
  return name || 'Item'
}

/**
 * Resolve the RAW route_to for each item's category, preserving null.
 *
 * Returns a map of menu_item_id -> raw route_to value (which may be null/undefined). Items with
 * no resolvable menu item are simply absent from the map, and the caller turns that into
 * 'unrouted'.
 *
 * A FAILED READ RESOLVES TO 'unrouted', NOT TO 'kitchen' AND NOT TO AN ERROR.
 *
 * Throwing would refuse the round, which means a waiter cannot take an order because a lookup
 * hiccuped -- the customer is sitting there either way. Defaulting to kitchen would put drinks
 * on the kitchen pass silently, which is the exact failure this module exists to prevent.
 * 'unrouted' loses nothing: every line still appears, on both screens, visibly flagged.
 */
async function fetchRawRouteToByMenuItemId(
  supabase: { from: (table: string) => any },
  menuItemIds: string[],
): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>()
  if (menuItemIds.length === 0) return result

  const { data: menuItems, error: menuItemsError } = await supabase
    .from('menu_items')
    .select('id, category_id')
    .in('id', menuItemIds)

  if (menuItemsError) {
    console.error('[ORDER LINES] menu_items read failed; lines will be unrouted', menuItemsError)
    return result
  }

  const categoryIds = [
    ...new Set(
      (menuItems || [])
        .map((row: { category_id?: string | null }) => String(row.category_id || '').trim())
        .filter(Boolean),
    ),
  ]

  const routeByCategoryId = new Map<string, unknown>()
  if (categoryIds.length > 0) {
    const { data: categories, error: categoriesError } = await supabase
      .from('menu_categories')
      .select('id, route_to')
      .in('id', categoryIds)

    if (categoriesError) {
      console.error(
        '[ORDER LINES] menu_categories read failed; lines will be unrouted',
        categoriesError,
      )
    } else {
      for (const category of categories || []) {
        // Stored RAW. No normalisation, no default -- null stays null all the way to 'unrouted'.
        routeByCategoryId.set(String(category.id), category.route_to)
      }
    }
  }

  for (const menuItem of menuItems || []) {
    const categoryId = String(menuItem.category_id || '').trim()
    if (routeByCategoryId.has(categoryId)) {
      result.set(String(menuItem.id), routeByCategoryId.get(categoryId))
    }
  }

  return result
}

export type BuiltOrderLine = {
  restaurant_id: string
  order_id: string
  tab_id: string | null
  source_item_index: number
  menu_item_id: string | null
  name_snapshot: string
  quantity: number
  line_note: string | null
  station: LineStation
  state: 'outstanding'
}

export type BuildOrderLinesParams = {
  restaurantId: string
  orderId: string
  tabId: string | null
  items: unknown
}

/**
 * Build the fulfilment lines for one order. Pure apart from the route_to lookup.
 *
 * An item with quantity 3 is ONE line of quantity 3, not three lines: the kitchen reads "3x
 * Steak" as one thing to make, and three separately bumpable rows would be three chances to
 * lose count of the same dish.
 */
export async function buildOrderLines(
  supabase: { from: (table: string) => any },
  params: BuildOrderLinesParams,
): Promise<BuiltOrderLine[]> {
  const items = Array.isArray(params.items) ? (params.items as OrderItemish[]) : []
  if (items.length === 0) return []

  const menuItemIds = [...new Set(items.map(readMenuItemId).filter(Boolean))]
  const rawRouteByMenuItemId = await fetchRawRouteToByMenuItemId(supabase, menuItemIds)

  const lines: BuiltOrderLine[] = []

  items.forEach((item, index) => {
    const menuItemId = readMenuItemId(item)
    // Absent from the map means unresolvable -- no menu item id, a deleted item, a failed read,
    // or a category we could not load. All of them are 'unrouted', all of them visible.
    const rawRouteTo = menuItemId ? rawRouteByMenuItemId.get(menuItemId) : undefined

    for (const station of stationsForRouteTo(rawRouteTo)) {
      lines.push({
        restaurant_id: params.restaurantId,
        order_id: params.orderId,
        tab_id: params.tabId,
        source_item_index: index,
        menu_item_id: menuItemId || null,
        name_snapshot: readName(item),
        quantity: readQuantity(item),
        line_note: readLineNote(item),
        station,
        state: 'outstanding',
      })
    }
  })

  return lines
}

export type WriteOrderLinesResult = {
  lineCount: number
  stationCounts: Record<LineStation, number>
}

/**
 * Insert the lines and their creation events.
 *
 * ONE insert for the lines and ONE for the events, rather than a row at a time: a partially
 * written order is an order the kitchen sees half of, and batching is the closest thing to
 * atomicity available through PostgREST.
 *
 * KNOWN GAP, DOCUMENTED RATHER THAN HIDDEN. The order row and its lines are still two round
 * trips, so a failure between them leaves an order with no lines -- an order the stations never
 * see. The caller answers non-2xx in that case and says so explicitly, and the proper fix is a
 * single RPC that writes both inside one transaction. That is a follow-up, not tonight's P0.
 */
export async function writeOrderLines(
  supabase: { from: (table: string) => any },
  lines: BuiltOrderLine[],
  actor: { actorKind: 'terminal' | 'station' | 'system'; actorUserId: string | null },
): Promise<WriteOrderLinesResult> {
  const stationCounts: Record<LineStation, number> = { kitchen: 0, bar: 0, unrouted: 0 }
  if (lines.length === 0) return { lineCount: 0, stationCounts }

  const { data: inserted, error: linesError } = await supabase
    .from('order_lines')
    .insert(lines)
    .select('id, station')

  if (linesError) throw linesError

  const insertedRows = (inserted || []) as Array<{ id: string; station: LineStation }>

  for (const row of insertedRows) {
    if (row.station in stationCounts) stationCounts[row.station] += 1
  }

  // The creation event. from_state is NULL because the line came from nowhere -- see the
  // migration's note on why 'created' is not a state.
  const events = insertedRows.map((row) => ({
    restaurant_id: lines[0].restaurant_id,
    order_line_id: row.id,
    from_state: null,
    to_state: 'outstanding',
    actor_kind: actor.actorKind,
    actor_user_id: actor.actorUserId,
  }))

  if (events.length > 0) {
    const { error: eventsError } = await supabase.from('order_line_events').insert(events)
    // A missing creation event is an incomplete audit trail, NOT a reason to fail the round and
    // leave the customer without food. Logged loudly; the lines themselves are already correct
    // and the stations can work from them.
    if (eventsError) {
      console.error('[ORDER LINES] creation events failed to write', eventsError)
    }
  }

  return { lineCount: insertedRows.length, stationCounts }
}
