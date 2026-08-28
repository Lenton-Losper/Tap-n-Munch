/**
 * feat/station-screens-v1 — order_lines / order_line_events shape.
 *
 * CORRECTED 2026-08-28 FROM LIVE DATA, not from the verbal description that preceded it. While
 * seeding staging, the first insert failed on an unknown column (`item_name`) — reading back
 * three real rows the other session had already written (an E2E smoke fixture: "Kitchen
 * probe", "E2E Probe Lager", "E2E Probe Sharing Platter", restaurant a1999166-ddfa-40d1-ad1f-
 * 2f01282a1652, order 789ffcc5-588c-449f-bcd2-370f4c408fe5) gave the actual column names and
 * actual values below directly, rather than guessing a second time. This is STILL not the
 * pasted DDL — it is three real rows, which prove the columns and the values THOSE rows used,
 * not the full space of valid values.
 *
 * CONFIRMED FROM LIVE ROWS:
 *  - order_lines columns: id, restaurant_id, order_id, tab_id, source_item_index, menu_item_id,
 *    name_snapshot (NOT item_name), quantity, line_note (nullable — free text, e.g. "medium"),
 *    route_to, kitchen_state, bar_state, created_at. NO `station`/sub-station column anywhere —
 *    not on order_lines, not on menu_items. The brief's "grouped by station" (grill/fry/salads)
 *    has no backing column in the schema as it stands; this is an open question for the human,
 *    not something to invent a fake grouping for. table_number lives on `orders`, not on
 *    order_lines — reached by join.
 *  - order_line_events columns: id, restaurant_id, order_line_id, station ('kitchen'|'bar' —
 *    this one DOES match what was assumed), from_state, to_state, actor_kind, actor_user_id,
 *    occurred_at (NOT created_at/event_type/created_by).
 *  - kitchen_state / bar_state VALUES OBSERVED: only 'outstanding' and 'done'. NOT the four
 *    values ('to_make','preparing','cooked','ready_to_run') relayed verbally on 2026-08-28 —
 *    those do not appear anywhere in the three real rows read back. It is possible 'cooked' /
 *    'ready_to_run' are real values this small E2E smoke sample simply never exercised; it is
 *    equally possible the two-tap Cooked/Ready-to-run UI corresponds to ONE persisted
 *    transition (outstanding -> done) plus an audit-only event, not two. NOT RESOLVED HERE —
 *    this needs the human, not a second guess. Everywhere in this codebase that reads
 *    kitchen_state, 'done' is treated as the internal 'ready_to_run' bucket (what the board
 *    shows in READY TO RUN) since it is the only proven terminal value.
 *  - route_to VALUES OBSERVED: 'kitchen', 'bar', 'both'. 'unrouted' was NOT observed in these
 *    three rows but was an explicit ruling relayed 2026-08-28 (not a guess), so it is kept.
 *  - The 'both' line in the sample (89fe25a2) proves INDEPENDENT bumping directly: kitchen and
 *    bar each carry their own from_state/to_state history, and one changing did not touch the
 *    other's column.
 *
 * STILL ASSUMED, not confirmed: waiter identity has no obvious column on `orders` or `tabs` —
 * `tabs.opened_by_user_id` is the closest candidate and is not resolved to a name here.
 * "Round" (the bar screen's unit) is still assumed to be the set of bar-routed order_lines
 * sharing one order_id, not its own table.
 */

export const ORDER_LINES_TABLE = 'order_lines'
export const ORDER_LINE_EVENTS_TABLE = 'order_line_events'

/** Only 'outstanding' and 'done' are proven. Treat anything else defensively, not by throwing. */
export type RawStationState = 'outstanding' | 'done' | string

export type RawOrderLine = {
  id: string
  restaurant_id: string
  order_id: string
  tab_id: string | null
  source_item_index: number | null
  menu_item_id: string | null
  name_snapshot: string
  quantity: number
  line_note: string | null
  route_to: 'kitchen' | 'bar' | 'both' | 'unrouted'
  created_at: string
  kitchen_state: RawStationState | null
  bar_state: RawStationState | null
}

export type RawOrderLineEvent = {
  id: string
  restaurant_id: string
  order_line_id: string
  station: 'kitchen' | 'bar'
  from_state: string | null
  to_state: string
  actor_kind: string
  actor_user_id: string | null
  occurred_at: string
}
