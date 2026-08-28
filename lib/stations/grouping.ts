/**
 * lib/stations/grouping.ts — zone-building, pure functions.
 *
 * REBUILT 20260829160000 for the pinned Ready zone; REBUILT AGAIN 20260829 (second pass) for the
 * Ready zone becoming a flat dispatch queue instead of grouped cards.
 *
 * route_to = 'unrouted' is never absorbed into either screen's ordinary zones — every function
 * here splits it out first, same as before. GET /api/station/lines already scopes its response to
 * lines/rounds the asking station owns and now to everything NOT collected/voided, so a 'ready'
 * line reaches this module for the first time — see lib/stations/types.ts's docblock.
 *
 * ============================================================================================
 * READY IS NOW A FLAT LIST OF LINES, NOT A LIST OF TABLES
 * ============================================================================================
 *
 * Second-pass redesign: "no production cards... it is a dispatch queue, not a shrunken production
 * card. Active answers 'what do I make', ready answers 'what can leave right now'." The first
 * pass grouped Ready by table (TableGroup / BarRound), the same shape ACTIVE uses. That was the
 * wrong shape for the question Ready actually answers — a waiter reading it wants "what dish, what
 * table, how long", one row per dish, not a table's worth of context around it. See
 * lib/stations/types.ts's DispatchRow.
 *
 * ACTIVE keeps the table/round grouping: it answers "what do I make", and a cook working a table
 * needs its lines together.
 *
 * ============================================================================================
 * A LINE CAN BE IN ACTIVE OR READY, NEVER SPLIT ACROSS BOTH ANY MORE — BUT A TABLE CAN
 * ============================================================================================
 *
 * "PER LINE, both boards" is a ruling this rebuild does not touch. A table with a plated steak and
 * an unstarted side has one line ready and one still outstanding — genuinely, at the same moment —
 * so that TABLE appears in both zones: an ACTIVE card carrying its still-outstanding line, and one
 * ready ROW carrying its finished one. The zones disagree about the table on purpose; that is the
 * whole point of tracking state per line rather than per round.
 *
 * ============================================================================================
 * "FIFO BY DEFAULT, BUT OVERDUE RISES VISUALLY" — READ AS A SORT, NOT ONLY A COLOUR
 * ============================================================================================
 *
 * Ungoverned by an exact ruling on whether "rises" means position or only colour, so the safer
 * default is the literal one: a table/round/row's position is decided by its worst escalation
 * first (louder floats above quieter) and by age WITHIN that tier second (oldest first) — see
 * lib/stations/age.ts's sortByUrgency. Same tier and nothing floats, so the ordinary case reads
 * exactly as FIFO; only a genuinely overdue item jumps the queue, and it does so in the same
 * direction its colour already argues for. Second-pass wording for the same rule: "tier first,
 * FIFO second." NOT SENT is not part of this sort at all — it is its own full-width strip, always
 * first, never interleaved; see kitchen-screen.tsx / bar-screen.tsx.
 *
 * EVERY ZONE ON EITHER BOARD SORTS THIS WAY NOW, INCLUDING THE BAR'S TO MAKE AND READY. Both were
 * ruled neutral or kitchen-matched at first and reversed at real volume (20260829): colour and
 * position are what let a cook or bartender find the oldest item without reading every table
 * number, and switching that off cost more than it saved once either board held a dozen-plus
 * items. THE STAKES STILL DIFFER, though — see lib/stations/age.ts's barActiveEscalation and
 * barReadyEscalation for the (later than the kitchen's) bands.
 */
import {
  ageMinutes,
  barActiveEscalation,
  barReadyEscalation,
  outstandingEscalation,
  readyToRunEscalation,
  sortByUrgency,
  sortOldestFirst,
  worstEscalation,
  type AgeEscalation,
} from '@/lib/stations/age'
import type { BarRound, BarRoundItem, DispatchRow, KitchenLine } from '@/lib/stations/types'

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

function clockMs(iso: string | null, now: number): number {
  const ms = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isFinite(ms) ? ms : now
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
  return clockMs(iso ?? null, now)
}

/**
 * A KITCHEN dispatch row's own urgency — the kitchen Ready zone's bands, unchanged by the
 * second-pass redesign (only its LAYOUT changed, from grouped cards to flat rows).
 */
export function kitchenReadyRowEscalation(row: DispatchRow, now: number): AgeEscalation {
  return readyToRunEscalation(ageMinutes(row.readyAt ?? row.placedAt ?? '', now))
}

/**
 * A BAR dispatch row's own urgency — the SOFTER bands (see age.ts's barReadyEscalation): "the
 * consequence of a waiting drink is lower than a waiting plate," a distinction the first pass's
 * shared-bands choice did not make.
 */
export function barReadyRowEscalation(row: DispatchRow, now: number): AgeEscalation {
  return barReadyEscalation(ageMinutes(row.readyAt ?? row.placedAt ?? '', now))
}

function dispatchRowClockMs(row: DispatchRow, now: number): number {
  return clockMs(row.readyAt ?? row.placedAt ?? null, now)
}

export type KitchenBoard = {
  /** Table number -> lines still outstanding or cooked. Ordered by worst escalation, then FIFO —
   *  see the module docblock. No sub-station grouping — order_lines has no such column. */
  activeByTable: TableGroup[]
  /** One row per line at 'ready', flat — not grouped by table. PINNED by the caller
   *  (kitchen-screen.tsx lays this out as its own bounded region), ordered by
   *  kitchenReadyRowEscalation then FIFO. */
  readyRows: DispatchRow[]
  unrouted: KitchenLine[]
}

export function buildKitchenBoard(lines: KitchenLine[], now: number = Date.now()): KitchenBoard {
  const unrouted = sortOldestFirst(
    lines.filter((line) => line.unrouted),
    (line) => line.placedAt ?? '',
  )
  const routed = lines.filter((line) => !line.unrouted)

  const activeLines = sortOldestFirst(
    routed.filter((line) => line.state !== 'ready'),
    (line) => (line.state === 'cooked' ? line.cookedAt ?? line.placedAt ?? '' : line.placedAt ?? ''),
  )

  const activeByTable = sortByUrgency(
    groupByTable(activeLines),
    (group) => worstEscalation(group.lines.map((line) => kitchenActiveLineEscalation(line, now))),
    (group) => Math.min(...group.lines.map((line) => kitchenActiveLineClockMs(line, now))),
  )

  const readyRowsUnsorted: DispatchRow[] = routed
    .filter((line) => line.state === 'ready')
    .map((line) => ({
      lineId: line.id,
      tableNumber: line.tableNumber,
      itemName: line.itemName,
      quantity: line.quantity,
      lineNote: line.lineNote,
      readyAt: line.readyAt,
      placedAt: line.placedAt,
    }))
  const readyRows = sortByUrgency(
    readyRowsUnsorted,
    (row) => kitchenReadyRowEscalation(row, now),
    (row) => dispatchRowClockMs(row, now),
  )

  return { activeByTable, readyRows, unrouted }
}

function itemsInState(round: BarRound, predicate: (item: BarRoundItem) => boolean): BarRound | null {
  const items = round.items.filter(predicate)
  return items.length === 0 ? null : { ...round, items }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

/**
 * A TO MAKE round's own clock. One clock, not two — unlike the kitchen, a bar line has no
 * 'cooked' sub-state in practice (the bar's own tap goes straight outstanding -> ready, see
 * bar-screen.tsx), so there is nothing analogous to kitchen-active's cookedAt-vs-placedAt split.
 * Every item in a round shares the round's own placedAt.
 */
export function barActiveLineEscalation(round: { placedAt: string | null }, now: number): AgeEscalation {
  return barActiveEscalation(ageMinutes(round.placedAt ?? '', now))
}

export type BarBoard = {
  /** Rounds carrying only their not-yet-ready items — the bar's "TO MAKE". Sorts by urgency on
   *  barActiveLineEscalation's (later) bands, same as every other zone — see the module docblock
   *  on the 20260829 reversal of the original "stays neutral" ruling. */
  active: BarRound[]
  /** One row per ready item, flat — not grouped by round. Sorted by barReadyRowEscalation then
   *  FIFO, softer bands than the kitchen's own Ready zone. */
  readyRows: DispatchRow[]
  unrouted: BarRound[]
}

export function buildBarBoard(rounds: BarRound[], now: number = Date.now()): BarBoard {
  const unrouted = sortOldestFirst(
    rounds.filter((round) => round.unrouted),
    (round) => round.placedAt ?? '',
  )
  const routed = rounds.filter((round) => !round.unrouted)

  const activeRounds = routed
    .map((round) => itemsInState(round, (item) => item.state !== 'ready'))
    .filter(isPresent)

  const active = sortByUrgency(
    activeRounds,
    (round) => barActiveLineEscalation(round, now),
    (round) => clockMs(round.placedAt, now),
  )

  const readyRowsUnsorted: DispatchRow[] = routed.flatMap((round) =>
    round.items
      .filter((item) => item.state === 'ready')
      .map((item) => ({
        lineId: item.id,
        tableNumber: round.tableNumber,
        itemName: item.itemName,
        quantity: item.quantity,
        lineNote: item.lineNote,
        readyAt: item.readyAt,
        placedAt: round.placedAt,
      })),
  )
  const readyRows = sortByUrgency(
    readyRowsUnsorted,
    (row) => barReadyRowEscalation(row, now),
    (row) => dispatchRowClockMs(row, now),
  )

  return { active, readyRows, unrouted }
}
