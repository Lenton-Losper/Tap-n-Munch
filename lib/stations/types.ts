/**
 * feat/station-screens-v1 — data shapes for the kitchen and bar screens.
 *
 * order_lines / order_line_events are owned by the service session on
 * feat/service-operations-v1 (a separate checkout, C:\Users\223125318\Desktop\mvp\
 * restaurant-menu-screen — never read or written from here). This file is the INTERNAL shape
 * every other file under lib/stations and components/stations is written against; the raw wire
 * shape (schema-assumptions.ts) maps into this one in lib/stations/map-raw-lines.ts, so a
 * schema change is a rewrite of that one file's mapping, not of the screens or their tests.
 *
 * Confirmed rulings (relayed 2026-08-28), reflected here:
 *  1. 'unrouted' is a value IN THE ENUM, not a null/absent route — see RouteTo below.
 *  2. route_to is copied onto the line at creation, resolved from the item at that moment, and
 *     never re-resolved — a menu edit later must not move food already cooking.
 *  3. A `route_to = 'both'` line carries independent state per station (order_lines'
 *     kitchen_state / bar_state, schema-assumptions.ts) — the kitchen bumping its half must
 *     never be visible as also having bumped the bar's, and vice versa. cookedAt/readyToRunAt
 *     below come only from kitchen_state (+ its order_line_events transition timestamp);
 *     outAt only from bar_state — never mixed.
 */

/** 'unrouted' is a real, distinct enum value and must never collapse to 'kitchen'. */
export type RouteTo = 'kitchen' | 'bar' | 'both' | 'unrouted'

export type KitchenLineStatus = 'outstanding' | 'cooked' | 'ready_to_run'

export type KitchenLine = {
  id: string
  tableNumber: string
  waiterName: string
  itemName: string
  quantity: number
  /** Kitchen sub-station this line belongs to -- "grill", "salads", etc. Distinct from routeTo. */
  station: string
  routeTo: RouteTo
  createdAt: string
  cookedAt: string | null
  /** Set the moment the pass bumps it -- the age READY TO RUN escalates on is measured from here. */
  readyToRunAt: string | null
}

export function kitchenLineStatus(line: KitchenLine): KitchenLineStatus {
  if (line.readyToRunAt) return 'ready_to_run'
  if (line.cookedAt) return 'cooked'
  return 'outstanding'
}

export type BarRoundItem = {
  itemName: string
  quantity: number
}

export type BarRound = {
  id: string
  tableNumber: string
  waiterName: string
  items: BarRoundItem[]
  routeTo: RouteTo
  createdAt: string
  /** Set the moment the one OUT tap fires. Null means the round is still IN. */
  outAt: string | null
}

export function barRoundIsOut(round: BarRound): boolean {
  return round.outAt !== null
}
