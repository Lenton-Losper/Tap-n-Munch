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

export type KitchenBoard = {
  /** "Cooked — awaiting pass". Escalates in urgency; see types.ts on what age this uses. */
  cooked: KitchenLine[]
  /** Table number -> lines. Table order follows first-seen (oldest line) order. No sub-station
   *  grouping — order_lines has no such column; see types.ts's docblock. */
  outstandingByTable: { tableNumber: string; lines: KitchenLine[] }[]
  unrouted: KitchenLine[]
}

export function buildKitchenBoard(lines: KitchenLine[]): KitchenBoard {
  const unrouted = lines.filter((line) => line.unrouted)
  const routed = lines.filter((line) => !line.unrouted)

  const cooked = sortOldestFirst(
    routed.filter((line) => line.state === 'cooked'),
    (line) => line.placedAt ?? '',
  )

  const outstanding = sortOldestFirst(
    routed.filter((line) => line.state === 'outstanding'),
    (line) => line.placedAt ?? '',
  )

  const tableOrder: string[] = []
  const byTable = new Map<string, KitchenLine[]>()
  for (const line of outstanding) {
    if (!byTable.has(line.tableNumber)) {
      tableOrder.push(line.tableNumber)
      byTable.set(line.tableNumber, [])
    }
    byTable.get(line.tableNumber)!.push(line)
  }

  const outstandingByTable = tableOrder.map((tableNumber) => ({
    tableNumber,
    lines: byTable.get(tableNumber)!,
  }))

  return { cooked, outstandingByTable, unrouted }
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
