/**
 * lib/stations/grouping.ts — zone-building, pure functions.
 *
 * REBUILT 20260829160000 for the pinned Ready zone.
 *
 * route_to = 'unrouted' is never absorbed into either screen's ordinary zones — every function
 * here splits it out first, same as before. GET /api/station/lines already scopes its response to
 * lines/rounds the asking station owns and now to everything NOT collected/voided, so a 'ready'
 * line reaches this module for the first time — see lib/stations/types.ts's docblock.
 *
 * ============================================================================================
 * A ROUND CAN BE IN BOTH ZONES AT ONCE, BECAUSE ITS LINES CAN BE
 * ============================================================================================
 *
 * "PER LINE, both boards" is a ruling this rebuild does not touch. A table with a plated steak
 * and an unstarted side has one line ready and one still outstanding — genuinely, at the same
 * moment — and a zone split that could only put the whole table in one place or the other would
 * have to lie about one of the two lines. So the split happens on LINES (kitchen) or ITEMS (bar),
 * not on tables or rounds: a table/round appears in the active zone carrying only its
 * not-yet-ready lines, and in the ready zone carrying only its ready ones, and it is entirely
 * normal for both to be non-empty for the same table at once.
 *
 * ============================================================================================
 * "FIFO BY DEFAULT, BUT OVERDUE RISES VISUALLY" — READ AS A SORT, NOT ONLY A COLOUR
 * ============================================================================================
 *
 * Ungoverned by an exact ruling on whether "rises" means position or only colour, so the safer
 * default is the literal one: a table/round's position is decided by its worst escalation first
 * (louder floats above quieter) and by age WITHIN that tier second (oldest first) — see
 * lib/stations/age.ts's sortByUrgency. Same tier and nothing floats, so the ordinary case reads
 * exactly as FIFO; only a genuinely overdue round jumps the queue, and it does so in the same
 * direction its colour already argues for.
 *
 * THE ONE ZONE THIS DOES NOT APPLY TO: the bar's TO MAKE (active) list. It carries no escalation
 * at all — "a warm beer is a smaller problem than a cold steak" — so there is nothing for it to
 * rank by, and it stays pure FIFO. See bar-screen.tsx.
 */
import {
  ageMinutes,
  outstandingEscalation,
  readyToRunEscalation,
  sortByUrgency,
  sortOldestFirst,
  worstEscalation,
  type AgeEscalation,
} from '@/lib/stations/age'
import type { BarRound, BarRoundItem, KitchenLine } from '@/lib/stations/types'

export type TableGroup = { tableNumber: string; lines: KitchenLine[] }

/** Table order follows the first line seen, so callers control it by sorting their input first. */
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

/**
 * A line still in the ACTIVE zone (outstanding or cooked). Two clocks, same reasoning the
 * previous rebuild fixed defect 4 with: an outstanding ticket ages on how long the kitchen has
 * HAD it (the slower bands); a cooked plate ages on how long it has sat waiting for the pass to
 * pass it (the faster bands) — reusing the fast bands for both is the exact defect that was fixed
 * on 2026-08-28 and this rebuild does not reopen it.
 */
export function kitchenActiveLineEscalation(line: KitchenLine, now: number): AgeEscalation {
  return line.state === 'cooked'
    ? readyToRunEscalation(ageMinutes(line.cookedAt ?? line.placedAt ?? '', now))
    : outstandingEscalation(ageMinutes(line.placedAt ?? '', now))
}

/** The clock an active line is judged on — the pass clock once cooked, the ticket clock before. */
function kitchenActiveLineClockMs(line: KitchenLine, now: number): number {
  const iso = line.state === 'cooked' ? line.cookedAt ?? line.placedAt : line.placedAt
  const ms = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isFinite(ms) ? ms : now
}

/**
 * A line waiting to be collected off the pass — shared by kitchen and bar (this rebuild's own
 * ruling: "the waiting-for-collection zone DOES age", on both boards, on the SAME clock). Falls
 * back to placedAt only if readyAt could not be read, same degrade-not-throw posture cookedAt
 * uses.
 */
export function readyLineEscalation(readyAt: string | null, placedAt: string | null, now: number): AgeEscalation {
  return readyToRunEscalation(ageMinutes(readyAt ?? placedAt ?? '', now))
}

function readyLineClockMs(readyAt: string | null, placedAt: string | null, now: number): number {
  const iso = readyAt ?? placedAt
  const ms = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isFinite(ms) ? ms : now
}

export type KitchenBoard = {
  /** Table number -> lines still outstanding or cooked. Ordered by worst escalation, then FIFO —
   *  see the module docblock. No sub-station grouping — order_lines has no such column. */
  activeByTable: TableGroup[]
  /** Table number -> lines at 'ready'. PINNED by the caller (kitchen-screen.tsx lays this out as
   *  its own bounded region), ordered the same way as activeByTable. */
  readyByTable: TableGroup[]
  unrouted: KitchenLine[]
}

export function buildKitchenBoard(lines: KitchenLine[], now: number = Date.now()): KitchenBoard {
  const unrouted = lines.filter((line) => line.unrouted)
  const routed = lines.filter((line) => !line.unrouted)

  const activeLines = sortOldestFirst(
    routed.filter((line) => line.state !== 'ready'),
    (line) => (line.state === 'cooked' ? line.cookedAt ?? line.placedAt ?? '' : line.placedAt ?? ''),
  )
  const readyLines = sortOldestFirst(
    routed.filter((line) => line.state === 'ready'),
    (line) => line.readyAt ?? line.placedAt ?? '',
  )

  const activeByTable = sortByUrgency(
    groupByTable(activeLines),
    (group) => worstEscalation(group.lines.map((line) => kitchenActiveLineEscalation(line, now))),
    (group) => Math.min(...group.lines.map((line) => kitchenActiveLineClockMs(line, now))),
  )
  const readyByTable = sortByUrgency(
    groupByTable(readyLines),
    (group) => worstEscalation(group.lines.map((line) => readyLineEscalation(line.readyAt, line.placedAt, now))),
    (group) => Math.min(...group.lines.map((line) => readyLineClockMs(line.readyAt, line.placedAt, now))),
  )

  return { activeByTable, readyByTable, unrouted }
}

function itemsInState(round: BarRound, predicate: (item: BarRoundItem) => boolean): BarRound | null {
  const items = round.items.filter(predicate)
  return items.length === 0 ? null : { ...round, items }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

export type BarBoard = {
  /** Rounds carrying only their not-yet-ready items — the bar's "TO MAKE". Pure FIFO; see the
   *  module docblock on why this one zone does not sort by urgency. */
  active: BarRound[]
  /** Rounds carrying only their ready (waiting-for-collection) items. Ages and sorts by urgency,
   *  same as the kitchen's ready zone — the one deliberate exception to the bar staying neutral. */
  ready: BarRound[]
  unrouted: BarRound[]
}

export function buildBarBoard(rounds: BarRound[], now: number = Date.now()): BarBoard {
  const unrouted = rounds.filter((round) => round.unrouted)
  const routed = rounds.filter((round) => !round.unrouted)

  const activeRounds = routed
    .map((round) => itemsInState(round, (item) => item.state !== 'ready'))
    .filter(isPresent)
  const readyRounds = routed
    .map((round) => itemsInState(round, (item) => item.state === 'ready'))
    .filter(isPresent)

  const active = sortOldestFirst(activeRounds, (round) => round.placedAt ?? '')

  const ready = sortByUrgency(
    readyRounds,
    (round) => worstEscalation(round.items.map((item) => readyLineEscalation(item.readyAt, round.placedAt, now))),
    (round) => Math.min(...round.items.map((item) => readyLineClockMs(item.readyAt, round.placedAt, now))),
  )

  return { active, ready, unrouted }
}
