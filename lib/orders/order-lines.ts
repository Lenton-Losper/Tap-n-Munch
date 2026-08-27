/**
 * ADR-005 §1 and §2 -- turning an order's items into fulfilment lines.
 *
 * ============================================================================================
 * ONE LINE PER ITEM, WITH PER-STATION STATE
 * ============================================================================================
 *
 * An item routed 'both' is ONE line carrying TWO states, not two lines.
 *
 *   * `kitchen_state` and `bar_state` are independent, so the kitchen marking its half done does
 *     not clear the bar's half.
 *   * There is still only one row, so a cancellation cancels one thing and the bill counts the
 *     item once.
 *
 * A station that does not own the line has NULL for its state, and a NULL cannot hold the line
 * back. `isLineReady` below is the single definition of "every station that owns this has marked
 * it", so the runner's view and the station screens cannot disagree about the same plate.
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
 * For a LINE it is forbidden. Ruled: route_to is not trusted, it is not silently corrected, and a
 * line that cannot be routed becomes 'unrouted' and shows on BOTH screens under a visible
 * heading. Production holds 4 items with a null route_to today. Under the existing helper all 4
 * would land silently in the kitchen; under this one they land visibly in front of both stations
 * and somebody asks why -- which is the entire point. A silent default is food nobody sees.
 *
 * So the two coexist on purpose. Changing `normalizeRouteTo` to match this would alter what the
 * POS and the existing station filters do to live orders, which is not in scope and was not ruled.
 *
 * ============================================================================================
 * route_to IS FROZEN AT CREATION
 * ============================================================================================
 *
 * Ruled as a general principle: a line records what was true when it was created. The category's
 * route_to is read once, here, and stored. A menu edit at 8pm must not move food that is already
 * cooking -- the same rule the immutable receipt snapshot follows.
 */

/** What a line routes to, frozen at creation. */
export type LineRouteTo = 'kitchen' | 'bar' | 'both' | 'unrouted'

/** A station that can own a line's state. 'unrouted' lines are owned by both. */
export type Station = 'kitchen' | 'bar'

export type LineState = 'outstanding' | 'done' | 'voided'

const ROUTE_KITCHEN = 'kitchen'
const ROUTE_BAR = 'bar'
const ROUTE_BOTH = 'both'

/**
 * Resolve a raw category route_to into the value frozen on the line.
 *
 * Deliberately total, and the fallback is 'unrouted' rather than 'kitchen'. An unrecognised
 * STRING is treated exactly like null: a category whose route_to says 'grill' is not a kitchen
 * item we happen to have spelled oddly, it is a value this code has never heard of, and
 * pretending to understand it is the silent correction the ruling forbids.
 */
export function routeToForLine(rawRouteTo: unknown): LineRouteTo {
  const value = typeof rawRouteTo === 'string' ? rawRouteTo.trim().toLowerCase() : ''
  if (value === ROUTE_KITCHEN) return 'kitchen'
  if (value === ROUTE_BAR) return 'bar'
  if (value === ROUTE_BOTH) return 'both'
  return 'unrouted'
}

/**
 * Which stations own a line. 'unrouted' is owned by BOTH -- it shows on both screens, so both
 * must be able to clear it.
 */
export function stationsOwnedBy(routeTo: LineRouteTo): Station[] {
  if (routeTo === 'kitchen') return ['kitchen']
  if (routeTo === 'bar') return ['bar']
  return ['kitchen', 'bar']
}

/** The initial per-station states. NULL for a station that does not own the line. */
export function initialStatesFor(routeTo: LineRouteTo): {
  kitchen_state: LineState | null
  bar_state: LineState | null
} {
  const owned = stationsOwnedBy(routeTo)
  return {
    kitchen_state: owned.includes('kitchen') ? 'outstanding' : null,
    bar_state: owned.includes('bar') ? 'outstanding' : null,
  }
}

/**
 * READY TO RUN: every station that owns this line has marked it.
 *
 * THE SINGLE DEFINITION. A NULL state is a station that does not own the line, so it cannot hold
 * the plate back -- which is why the coalesce is to 'done' and not to 'outstanding'. Two callers
 * writing this predicate by hand is how the runner's view and the kitchen screen end up
 * disagreeing about whether the same plate can go out.
 */
export function isLineReady(line: {
  kitchen_state?: LineState | null
  bar_state?: LineState | null
}): boolean {
  return (line.kitchen_state ?? 'done') === 'done' && (line.bar_state ?? 'done') === 'done'
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
  route_to: LineRouteTo
  kitchen_state: LineState | null
  bar_state: LineState | null
}

export type BuildOrderLinesParams = {
  restaurantId: string
  orderId: string
  tabId: string | null
  items: unknown
}

/**
 * Build the fulfilment lines for one order. One line per item, always.
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

  return items.map((item, index) => {
    const menuItemId = readMenuItemId(item)
    // Absent from the map means unresolvable -- no menu item id, a deleted item, a failed read,
    // or a category we could not load. All of them are 'unrouted', all of them visible.
    const rawRouteTo = menuItemId ? rawRouteByMenuItemId.get(menuItemId) : undefined
    const routeTo = routeToForLine(rawRouteTo)

    return {
      restaurant_id: params.restaurantId,
      order_id: params.orderId,
      tab_id: params.tabId,
      source_item_index: index,
      menu_item_id: menuItemId || null,
      name_snapshot: readName(item),
      quantity: readQuantity(item),
      line_note: readLineNote(item),
      route_to: routeTo,
      ...initialStatesFor(routeTo),
    }
  })
}

export type WriteOrderLinesResult = {
  lineCount: number
  /** How many lines each screen will show. An 'unrouted' line counts to all three. */
  stationCounts: { kitchen: number; bar: number; unrouted: number }
}

/**
 * Insert the lines and their creation events.
 *
 * ONE insert for the lines and ONE for the events, rather than a row at a time: a partially
 * written order is an order the kitchen sees half of, and batching is the closest thing to
 * atomicity available through PostgREST.
 *
 * A 'both' or 'unrouted' line produces TWO creation events, one per station it owns, because an
 * event records which of the line's two states moved.
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
  const stationCounts = { kitchen: 0, bar: 0, unrouted: 0 }
  if (lines.length === 0) return { lineCount: 0, stationCounts }

  const { data: inserted, error: linesError } = await supabase
    .from('order_lines')
    .insert(lines)
    .select('id, route_to')

  if (linesError) throw linesError

  const insertedRows = (inserted || []) as Array<{ id: string; route_to: LineRouteTo }>

  const events: Array<Record<string, unknown>> = []

  for (const row of insertedRows) {
    const owned = stationsOwnedBy(row.route_to)
    if (owned.includes('kitchen')) stationCounts.kitchen += 1
    if (owned.includes('bar')) stationCounts.bar += 1
    if (row.route_to === 'unrouted') stationCounts.unrouted += 1

    // One creation event per station that owns the line. from_state is NULL because the line came
    // from nowhere -- see the migration's note on why 'created' is not a state.
    for (const station of owned) {
      events.push({
        restaurant_id: lines[0].restaurant_id,
        order_line_id: row.id,
        station,
        from_state: null,
        to_state: 'outstanding',
        actor_kind: actor.actorKind,
        actor_user_id: actor.actorUserId,
      })
    }
  }

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
