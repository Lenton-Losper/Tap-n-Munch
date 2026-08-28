/**
 * lib/stations/grouping.ts — zone-building, pure functions.
 *
 * REBUILT 2026-08-28 for the real four-state model — see lib/stations/types.ts's docblock for
 * why there is no "ready" zone on either screen and no persisted bar OUT column.
 *
 * route_to = 'unrouted' is never absorbed into either screen's ordinary zones — every function
 * here splits it out first. Unlike the old (guessed-schema) version, this no longer needs to
 * filter routed-vs-not: GET /api/station/lines already scopes its response to lines/rounds the
 * asking station owns (kitchen_state or bar_state IS NOT NULL), so everything reaching this
 * module already belongs on this screen.
 */
import { sortOldestFirst } from '@/lib/stations/age'
import type { BarRound, KitchenLine } from '@/lib/stations/types'

export type TableGroup = { tableNumber: string; lines: KitchenLine[] }

export type KitchenBoard = {
  /** "Cooked — awaiting pass", flat and oldest-first. Kept because it is the ORDER the pass reads
   *  in; the board renders `cookedByTable` so the per-table shortcut has a card to live on. */
  cooked: KitchenLine[]
  /**
   * The same cooked lines, one group per table.
   *
   * ADDED for the wall rebuild. The pass zone used to be one card per LINE, which meant there was
   * no per-table object for "all ready to run" to attach to, and a table of five plates was five
   * separate cards scattered by age across the grid — so running one table meant finding its cards
   * first. Grouped, the card is the unit a runner actually carries.
   *
   * Ordered by the oldest PASS clock in each group (cookedAt, falling back to the order's age when
   * the cooked event could not be read), not by the order's age, for the same reason the colour is:
   * how long the plate has sat is the question, not how long ago they ordered.
   */
  cookedByTable: TableGroup[]
  /** Table number -> lines. Table order follows first-seen (oldest line) order. No sub-station
   *  grouping — order_lines has no such column; see types.ts's docblock. */
  outstandingByTable: TableGroup[]
  unrouted: KitchenLine[]
}

/** Table order follows the first line seen, so callers control it by sorting their input. */
function groupByTable(lines: KitchenLine[]): TableGroup[] {
  const tableOrder: string[] = []
  const byTable = new Map<string, KitchenLine[]>()
  for (const line of lines) {
    if (!byTable.has(line.tableNumber)) {
      tableOrder.push(line.tableNumber)
      byTable.set(line.tableNumber, [])
    }
    byTable.get(line.tableNumber)!.push(line)
  }
  return tableOrder.map((tableNumber) => ({ tableNumber, lines: byTable.get(tableNumber)! }))
}

export function buildKitchenBoard(lines: KitchenLine[]): KitchenBoard {
  const unrouted = lines.filter((line) => line.unrouted)
  const routed = lines.filter((line) => !line.unrouted)

  const cooked = sortOldestFirst(
    routed.filter((line) => line.state === 'cooked'),
    (line) => line.placedAt ?? '',
  )

  const cookedByPassClock = sortOldestFirst(
    routed.filter((line) => line.state === 'cooked'),
    (line) => line.cookedAt ?? line.placedAt ?? '',
  )

  const outstanding = sortOldestFirst(
    routed.filter((line) => line.state === 'outstanding'),
    (line) => line.placedAt ?? '',
  )

  return {
    cooked,
    cookedByTable: groupByTable(cookedByPassClock),
    outstandingByTable: groupByTable(outstanding),
    unrouted,
  }
}

export type BarBoard = {
  /** Everything still IN — a round that reaches 'ready' leaves GET /api/station/lines' response
   *  entirely and therefore leaves this list; there is no persisted "out" archive. See
   *  bar-screen.tsx and the report this rebuild shipped with. */
  in: BarRound[]
  unrouted: BarRound[]
}

export function buildBarBoard(rounds: BarRound[]): BarBoard {
  const unrouted = rounds.filter((round) => round.unrouted)
  const inRounds = sortOldestFirst(
    rounds.filter((round) => !round.unrouted),
    (round) => round.placedAt ?? '',
  )

  return { in: inRounds, unrouted }
}
