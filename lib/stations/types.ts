/**
 * lib/stations/types.ts — data shapes for the kitchen and bar wall screens.
 *
 * ============================================================================================
 * REBUILT 2026-08-28 AGAINST THE REAL FOUR-STATE MODEL
 * ============================================================================================
 *
 * order_lines / order_line_events are owned by lib/orders/order-lines.ts and
 * app/api/station/lines/route.ts (ADR-005 §1 and §5), which this file is now built directly
 * against — see lib/stations/map-raw-lines.ts, which maps that route's REAL response into the
 * shapes below. lib/stations/schema-assumptions.ts (a guessed, pre-domain-model shape) is
 * retired.
 *
 * THE REAL VOCABULARY IS FOUR STATES, TWO ACTORS (lib/orders/order-lines.ts):
 *
 *   outstanding -> nobody has started it
 *   cooked      -> the STATION made it, waiting on the pass
 *   ready       -> the PASS passed it — what a waiter walks in to read
 *   voided      -> cancelled or amended at the terminal
 *
 * ============================================================================================
 * WHY THERE IS NO "READY" ZONE ON EITHER SCREEN BELOW
 * ============================================================================================
 *
 * GET /api/station/lines filters to NOT-FINISHED for the station that asked
 * (`.not(stateColumn, 'in', '("ready","voided")')`) — see that route's own docblock. A line whose
 * kitchen_state (or bar_state) is 'ready' is EXCLUDED from that station's own board response,
 * server-side, unconditionally. That is not a bug this rebuild works around — it is correct: once
 * a station's half is 'ready', that station's own screen is not the one that still needs to see
 * it. The screen that reads 'ready' lines is the runner/pass view lib/orders/order-lines.ts's own
 * docblock describes ("This is what a waiter walks in to read") — no such screen exists in this
 * codebase yet, and building one is out of scope here; see the report this rebuild shipped with.
 *
 * Consequently:
 *   - KitchenLineState below is only ever 'outstanding' | 'cooked' — 'ready' cannot reach it.
 *   - BarRound below carries no "is this round out yet" flag at all — a round that reaches
 *     'ready' leaves GET /api/station/lines' response for station=bar entirely, the same as a
 *     kitchen line does. There is no persisted OUT column; see grouping.ts and bar-screen.tsx.
 *
 * ============================================================================================
 * NO PER-LINE TRANSITION TIMESTAMP EITHER
 * ============================================================================================
 *
 * The old (guessed) design derived a card's "how long has this been waiting" from
 * order_line_events' occurred_at. GET /api/station/lines returns no event data and no per-line
 * created_at — only `placed_at` / `seconds_waiting` PER ORDER. So the urgency clock the kitchen
 * screen's cooked-and-waiting zone escalates on is ORDER age (time since the order was placed),
 * not per-line cooked age. A dish cooked two minutes ago on a ten-minute-old order reads exactly
 * as urgent as one cooked ten minutes ago on that same order. That is a real, stated compromise —
 * the alternative (a per-line cooked_at) does not exist in the contract this rebuild was told not
 * to second-guess.
 *
 * ============================================================================================
 * NO SUB-STATION GROUPING, NO WAITER NAME
 * ============================================================================================
 *
 * The old (guessed) KitchenLine.station ("grill"/"salads"/"fry") and both types' waiterName had
 * no backing column anywhere (schema-assumptions.ts's own docblock said as much) and are dropped
 * here rather than carried forward as fiction. GET /api/station/lines' line/order shape has
 * neither.
 */
import type { LineRouteTo } from '@/lib/orders/order-lines'

export type RouteTo = LineRouteTo

/** A line on the kitchen board. Never 'ready' or 'voided' — see the module docblock. */
export type KitchenLineState = 'outstanding' | 'cooked'

export type KitchenLine = {
  id: string
  orderId: string
  tableNumber: string
  orderNumber: string | number | null
  itemName: string
  quantity: number
  lineNote: string | null
  routeTo: RouteTo
  state: KitchenLineState
  /** The order's placed_at — see the module docblock on why this is order age, not line age. */
  placedAt: string | null
  unrouted: boolean
  /** True for a 'both' or 'unrouted' line — the bar also has (or shares) this line. */
  sharedWithOtherStation: boolean
}

export type BarRoundItem = {
  itemName: string
  quantity: number
  lineNote: string | null
}

/**
 * All bar-owned lines sharing one order — GET /api/station/lines already groups by order into
 * one card, so a "round" is exactly one card, not a re-derived grouping.
 */
export type BarRound = {
  id: string
  tableNumber: string
  orderNumber: string | number | null
  items: BarRoundItem[]
  placedAt: string | null
  /** True if ANY line in this round is unrouted. Round-level, not line-level: splitting one
   *  physical ticket across two UI sections would be worse than flagging the whole round loud. */
  unrouted: boolean
}
