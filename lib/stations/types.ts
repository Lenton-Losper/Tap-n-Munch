/**
 * lib/stations/types.ts — data shapes for the kitchen and bar wall screens.
 *
 * ============================================================================================
 * REBUILT 20260829160000 FOR THE PINNED READY ZONE
 * ============================================================================================
 *
 * order_lines / order_line_events are owned by lib/orders/order-lines.ts and
 * app/api/station/lines/route.ts (ADR-005 §1 and §5), which this file is built directly against
 * — see lib/stations/map-raw-lines.ts, which maps that route's REAL response into the shapes
 * below.
 *
 * THE REAL VOCABULARY IS FIVE STATES, TWO ACTORS (lib/orders/order-lines.ts):
 *
 *   outstanding -> nobody has started it
 *   cooked      -> the STATION made it, waiting on the pass
 *   ready       -> the PASS passed it — what a waiter walks in to read
 *   collected   -> someone took it off the pass
 *   voided      -> cancelled or amended at the terminal
 *
 * ============================================================================================
 * WHY THERE IS NOW A "READY" ZONE, WHEN THE PREVIOUS REBUILD SAID THERE COULD NOT BE ONE
 * ============================================================================================
 *
 * `GET /api/station/lines` used to filter to NOT-FINISHED (`.not(stateColumn, 'in',
 * '("ready","voided")')`), so a line at 'ready' was excluded from a station's own board
 * entirely — the previous version of this file's own docblock explained that gap and called
 * building a ready screen "out of scope here."
 *
 * That is exactly the gap the board rebuild closes: finished food sitting above active work was
 * backwards, and fixing it needs the two zones to be REAL — active work AND a pinned ready zone
 * on the SAME screen the station already uses, not a second screen. The route now excludes only
 * `('collected','voided')`, so 'ready' lines stay on the board until someone marks them
 * 'collected' — see lib/orders/order-lines.ts's docblock on why that state was added.
 *
 * Consequently:
 *   - KitchenLineState is 'outstanding' | 'cooked' | 'ready' — never 'collected' (a collected
 *     line has LEFT the board; see the route's filter) or 'voided' (never a station's to show as
 *     live work).
 *   - BarRoundItem carries its OWN state, not a round-level flag — "PER LINE, both boards" is a
 *     ruling this rebuild must not change: a round with three drinks made and one not is a real
 *     shape, and collapsing it to one round-level status would hide the one still outstanding.
 *
 * ============================================================================================
 * TWO CLOCKS PER LINE NOW, NOT ONE
 * ============================================================================================
 *
 * `cookedAt` answers "how long has this sat on the pass, uncalled" — unchanged from the previous
 * rebuild. `readyAt` is the same idea one step later: "how long has this sat ready, uncollected."
 * Both come from `order_line_events.occurred_at` for this line's own `to_state` transition (see
 * the route), both null until their transition has happened, and both degrade to the order's
 * placedAt on read failure rather than throwing — see kitchen-screen.tsx / bar-screen.tsx for
 * which clock each zone actually escalates on.
 *
 * ============================================================================================
 * NO SUB-STATION GROUPING, NO WAITER NAME
 * ============================================================================================
 *
 * Neither has a backing column anywhere and both stay dropped, per the previous rebuild's own
 * note — GET /api/station/lines' line/order shape still has neither.
 */
import type { LineRouteTo } from '@/lib/orders/order-lines'

export type RouteTo = LineRouteTo

/** A line on the kitchen board. Never 'collected' or 'voided' — see the module docblock. */
export type KitchenLineState = 'outstanding' | 'cooked' | 'ready'

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
  /**
   * The order's placed_at. Correct for OUTSTANDING work — how long the kitchen has had the
   * ticket — and it is what the outstanding side is sorted and aged on.
   */
  placedAt: string | null
  /**
   * When this station tapped Cooked, from order_line_events. Null while still outstanding.
   *
   * A cooked line escalates on THIS, not on placedAt. Order age answers "how long ago did they
   * order", which for a dish already made is the wrong question — a steak that took eleven honest
   * minutes would open red the moment it was tapped, and every cooked card went red within six
   * minutes of the round landing. This clock answers "how long has it been sitting on the pass",
   * which is the thing that actually goes cold.
   */
  cookedAt: string | null
  /**
   * When this line reached 'ready', from order_line_events. Null until then.
   *
   * The pinned Ready zone escalates on THIS — a food-safety and money question ("this has been
   * sitting finished for how long"), not the same clock cookedAt answers.
   */
  readyAt: string | null
  unrouted: boolean
  /** True for a 'both' or 'unrouted' line — the bar also has (or shares) this line. */
  sharedWithOtherStation: boolean
}

/** Same three values as the kitchen — a bar line just usually skips 'cooked' (see bar-screen.tsx
 *  on why the bar's own tap goes straight outstanding -> ready). The type stays shared because
 *  nothing about order_lines' vocabulary is station-specific. */
export type BarLineState = KitchenLineState

export type BarRoundItem = {
  /**
   * The order_line id. Carried so the bar can bump ONE drink, and now so a round can be split
   * between the active and ready zones without losing which physical item is which — see
   * lib/stations/grouping.ts's splitRoundByReadiness.
   */
  id: string
  itemName: string
  quantity: number
  lineNote: string | null
  /** PER LINE — a round is not poured, cooked or collected all at once. Ruled, not to change. */
  state: BarLineState
  /** Same two clocks as the kitchen line, same reasons — see KitchenLine.cookedAt/readyAt. */
  cookedAt: string | null
  readyAt: string | null
}

/**
 * All bar-owned lines sharing one order — GET /api/station/lines already groups by order into
 * one card, so a "round" is exactly one card, not a re-derived grouping.
 *
 * A round with a mix of states is split by lib/stations/grouping.ts into an active view and a
 * ready view of the SAME round, each carrying only the items that belong there — the round
 * itself is not "in one zone or the other," its items are.
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

/**
 * ONE ROW ON THE READY ZONE — the second-pass board redesign (20260829). "No production cards.
 * Dense rows... it is a dispatch queue, not a shrunken production card." Shared by both boards on
 * purpose ("same language, same dimensions") so kitchen-screen.tsx and bar-screen.tsx render
 * their Ready zones from the exact same primitive (components/stations/dispatch-row.tsx) rather
 * than each inventing its own — that divergence is the thing this redesign exists to prevent.
 *
 * Deliberately NOT grouped by table. A round used to reach the Ready zone as a TableGroup/BarRound
 * carrying only its ready lines; now each ready LINE is its own row, table number carried inline
 * as a column rather than a heading, because "T12 · Ribeye MR · READY 02:11 · [Collected]" names
 * one dish, not one table.
 */
export type DispatchRow = {
  lineId: string
  tableNumber: string
  itemName: string
  quantity: number
  lineNote: string | null
  /** When this line reached 'ready' — the clock this row's own elapsed time is measured from.
   *  Falls back to placedAt only if readyAt could not be read, same posture every other clock in
   *  this module already takes. */
  readyAt: string | null
  placedAt: string | null
}
