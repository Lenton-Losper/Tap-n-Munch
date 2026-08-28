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

/**
 * Four states, two actors.
 *
 *   outstanding -> nobody has started it
 *   cooked      -> the STATION has made it and is waiting on the pass. Durable, deliberately: a
 *                  cook who plated a dish two minutes ago and one who has not started must not
 *                  look identical on the board. That is the whole reason the pass exists.
 *   ready       -> the PASS has passed it. This is what a waiter walks in to read.
 *   voided      -> cancelled or amended at the terminal.
 *
 * 'done' is RETIRED as a stored value (20260828141000). It meant "this station has finished",
 * which under this vocabulary is `ready` -- the old model had no pass, so finished and
 * ready-to-run were one event. It survives only as an input alias, translated at the endpoint,
 * so no client breaks mid-deploy. It is deliberately absent from this type.
 */
export type LineState = 'outstanding' | 'cooked' | 'ready' | 'voided'

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
  // READY, not cooked. A plated dish waiting on the pass is NOT ready to run, and that
  // distinction is the entire point of the four-state vocabulary. The coalesce is to 'ready'
  // because a NULL means a station that does not own the line and therefore cannot hold it back.
  return (line.kitchen_state ?? 'ready') === 'ready' && (line.bar_state ?? 'ready') === 'ready'
}

/**
 * Is this station still working on the line? True for outstanding AND cooked -- a cooked dish is
 * still the station's business until the pass takes it.
 *
 * Expressed as "not finished" rather than as a list of active states on purpose: the vocabulary
 * has grown once already tonight, and a predicate that enumerates the ACTIVE values has to be
 * revisited every time it grows, while one that enumerates the TERMINAL values does not.
 */
export function isStationOutstanding(state: LineState | null | undefined): boolean {
  if (state == null) return false
  return state !== 'ready' && state !== 'voided'
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
const NOTE_KEYS = [
  'note',
  'notes',
  'lineNote',
  'line_note',
  'specialInstructions',
  'special_instructions',
  'instructions',
] as const

function readLineNote(item: OrderItemish): string | null {
  for (const key of NOTE_KEYS) {
    const candidate = item[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    // A number is a strange note but it survives the trip intact and means what it says.
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return null
}

/**
 * Find the first item carrying a note that is neither a string nor a number.
 *
 * ============================================================================================
 * WHY THIS REFUSES RATHER THAN COERCING OR DROPPING
 * ============================================================================================
 *
 * `line_note` is a text column, and Postgres does NOT refuse an object -- it coerces. A note sent
 * as `{ text: 'medium' }` lands in the database as the literal string "[object Object]", and a
 * cook reads it off the pass at 8pm.
 *
 * Dropping it silently is no better and is arguably worse: the customer asked for their steak
 * medium, the note vanishes between the P5 and the kitchen, the steak comes out wrong, and
 * nothing anywhere recorded that a note was ever sent. A wrong plate with no evidence is the
 * hardest kind of bug to chase the next morning.
 *
 * So a malformed note refuses the ROUND, with the offending index named. The client is our own
 * APK, built against a brief that says to send a string; a 400 during development is exactly
 * when this should be found, and by the time it is in a venue the shape is fixed.
 *
 * Numbers and strings are both accepted, because both survive the trip meaning what they say.
 */
export function findInvalidLineNoteIndex(items: unknown): number | null {
  if (!Array.isArray(items)) return null

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as OrderItemish | null
    if (!item || typeof item !== 'object') continue

    for (const key of NOTE_KEYS) {
      const candidate = item[key]
      if (candidate === undefined || candidate === null) continue
      if (typeof candidate === 'string') continue
      if (typeof candidate === 'number' && Number.isFinite(candidate)) continue
      return index
    }
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

export type VoidOrderLinesResult = {
  /** Lines with at least one station-half voided by this call. */
  voidedLineCount: number
}

/**
 * VOID EVERY STILL-OUTSTANDING HALF OF AN ORDER'S LINES. Filed as
 * docs/followup-cancelled-order-lines-not-voided.md, 2026-08-28 — nothing wrote this, so a
 * cancelled order's lines sat at `outstanding`, indistinguishable from real, live, unstarted
 * work. Measured: 7 cancelled orders, 16 lines, every kitchen/both line still `outstanding`.
 *
 * CALLED FROM WHEREVER AN ORDER IS CANCELLED, not from a board-read route. `GET
 * /api/station/lines` has no `orders.status` awareness and is not getting one here — filtering by
 * order status in every board-reading route treats the symptom in N places instead of the cause
 * in one, which is the followup doc's own conclusion.
 *
 * ONLY A STATION-HALF THAT IS STILL OUTSTANDING VOIDS — `isStationOutstanding` (outstanding or
 * cooked). A half that already reached `ready` is untouched: the kitchen already made it and the
 * pass already passed it, and cancelling the order afterward does not un-cook the plate. Whether
 * that food still goes out is an ORDER-level question (refunded, comped, eaten anyway), not a
 * reason to rewrite what the board already correctly showed as done.
 *
 * ONE EVENT PER VOIDED STATION-HALF, matching writeOrderLines' own shape: `order_line_events`
 * needs an event per station a line was routed to, not per line, so a 'both' line voids as two
 * events when both halves were still outstanding.
 *
 * A FAILED EVENTS INSERT DOES NOT THROW, matching writeOrderLines' own choice: the lines
 * themselves are already correctly voided by the time the events insert runs, and losing the
 * audit trail for a cancellation is a logged gap, not a reason to leave the board wrong.
 */
export async function voidOutstandingOrderLines(
  supabase: { from: (table: string) => any },
  params: {
    orderId: string
    restaurantId: string
    actorKind: 'terminal' | 'station' | 'system'
    actorUserId: string | null
  },
): Promise<VoidOrderLinesResult> {
  const { data: lines, error: linesError } = await supabase
    .from('order_lines')
    .select('id, kitchen_state, bar_state')
    .eq('order_id', params.orderId)
    .eq('restaurant_id', params.restaurantId)

  if (linesError) throw linesError

  const rows = (lines ?? []) as Array<{
    id: string
    kitchen_state: LineState | null
    bar_state: LineState | null
  }>

  const events: Array<Record<string, unknown>> = []
  let voidedLineCount = 0

  for (const line of rows) {
    const voidKitchen = isStationOutstanding(line.kitchen_state)
    const voidBar = isStationOutstanding(line.bar_state)
    if (!voidKitchen && !voidBar) continue

    // Captured BEFORE the update, not read off `line` afterward -- an event's from_state must
    // record what the state WAS, and reading it back off the same object after an update is a
    // trap the moment anything (a mock, a future caller) mutates in place rather than replacing.
    const priorKitchenState = line.kitchen_state
    const priorBarState = line.bar_state

    const patch: Record<string, LineState> = {}
    if (voidKitchen) patch.kitchen_state = 'voided'
    if (voidBar) patch.bar_state = 'voided'

    const { error: updateError } = await supabase
      .from('order_lines')
      .update(patch)
      .eq('id', line.id)
    if (updateError) throw updateError

    voidedLineCount += 1

    if (voidKitchen) {
      events.push({
        restaurant_id: params.restaurantId,
        order_line_id: line.id,
        station: 'kitchen',
        from_state: priorKitchenState,
        to_state: 'voided',
        actor_kind: params.actorKind,
        actor_user_id: params.actorUserId,
      })
    }
    if (voidBar) {
      events.push({
        restaurant_id: params.restaurantId,
        order_line_id: line.id,
        station: 'bar',
        from_state: priorBarState,
        to_state: 'voided',
        actor_kind: params.actorKind,
        actor_user_id: params.actorUserId,
      })
    }
  }

  if (events.length > 0) {
    const { error: eventsError } = await supabase.from('order_line_events').insert(events)
    if (eventsError) {
      console.error('[ORDER LINES] void events failed to write', eventsError)
    }
  }

  return { voidedLineCount }
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
