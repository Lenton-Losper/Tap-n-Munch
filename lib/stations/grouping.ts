/**
 * feat/station-screens-v1 — grouping and filtering, pure functions.
 *
 * route_to = 'unrouted' is never absorbed into either screen's ordinary zones (see types.ts's
 * RouteTo docstring) — every function here splits it out first, so a caller cannot forget to.
 * route_to = 'both' is not filtered out here at all: both screens receive the same line/round
 * and each derives its own status independently (types.ts's kitchenLineStatus /
 * barRoundIsOut), which is what makes the two bumps independent.
 */
import { sortOldestFirst } from '@/lib/stations/age'
import { kitchenLineStatus, type BarRound, type KitchenLine } from '@/lib/stations/types'

function isRoutedToKitchen(routeTo: KitchenLine['routeTo']): boolean {
  return routeTo === 'kitchen' || routeTo === 'both'
}

function isRoutedToBar(routeTo: BarRound['routeTo']): boolean {
  return routeTo === 'bar' || routeTo === 'both'
}

export type KitchenBoard = {
  readyToRun: KitchenLine[]
  /** Table number -> station -> lines. Table order follows first-seen (oldest line) order. */
  outstandingByTable: { tableNumber: string; stationGroups: { station: string; lines: KitchenLine[] }[] }[]
  unrouted: KitchenLine[]
}

export function buildKitchenBoard(lines: KitchenLine[]): KitchenBoard {
  const unrouted = lines.filter((line) => line.routeTo === 'unrouted')
  const routed = lines.filter((line) => isRoutedToKitchen(line.routeTo))

  const readyToRun = sortOldestFirst(
    routed.filter((line) => kitchenLineStatus(line) === 'ready_to_run'),
    (line) => line.readyToRunAt as string,
  )

  const outstanding = sortOldestFirst(
    routed.filter((line) => kitchenLineStatus(line) !== 'ready_to_run'),
    (line) => line.createdAt,
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

  const outstandingByTable = tableOrder.map((tableNumber) => {
    const tableLines = byTable.get(tableNumber)!
    const stationOrder: string[] = []
    const byStation = new Map<string, KitchenLine[]>()
    for (const line of tableLines) {
      if (!byStation.has(line.station)) {
        stationOrder.push(line.station)
        byStation.set(line.station, [])
      }
      byStation.get(line.station)!.push(line)
    }
    return {
      tableNumber,
      stationGroups: stationOrder.map((station) => ({ station, lines: byStation.get(station)! })),
    }
  })

  return { readyToRun, outstandingByTable, unrouted }
}

export type BarBoard = {
  in: BarRound[]
  out: BarRound[]
  unrouted: BarRound[]
}

export function buildBarBoard(rounds: BarRound[]): BarBoard {
  const unrouted = rounds.filter((round) => round.routeTo === 'unrouted')
  const routed = rounds.filter((round) => isRoutedToBar(round.routeTo))

  const inRounds = sortOldestFirst(
    routed.filter((round) => round.outAt === null),
    (round) => round.createdAt,
  )

  // Most-recently-out first: OUT reads as a log of what just left, not a queue to work through.
  const outRounds = [...routed.filter((round) => round.outAt !== null)].sort(
    (a, b) => new Date(b.outAt as string).getTime() - new Date(a.outAt as string).getTime(),
  )

  return { in: inRounds, out: outRounds, unrouted }
}
