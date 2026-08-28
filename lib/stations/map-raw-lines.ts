/**
 * feat/station-screens-v1 — maps RawOrderLine (+ RawOrderLineEvent, for timestamps) into the
 * KitchenLine / BarRound shape components/stations already renders. Pure and unit-testable so
 * the mapping is provable independent of the schema under it.
 *
 * CORRECTED 2026-08-28 to the real column/value shape read back from live staging rows — see
 * schema-assumptions.ts's docblock for exactly what changed and what is still open.
 * kitchen_state/bar_state = 'done' is read as the internal 'ready_to_run' bucket; anything else
 * non-null is read as 'outstanding' — there is no proven third value to distinguish a 'cooked'
 * state from 'outstanding' yet.
 *
 * table_number is not a column on order_lines — it lives on `orders` — so this takes a lookup
 * map keyed by order_id rather than reading it off the line.
 */
import type { RawOrderLine, RawOrderLineEvent } from '@/lib/stations/schema-assumptions'
import type { BarRound, KitchenLine } from '@/lib/stations/types'

const DONE = 'done'

function transitionTimestamp(
  events: RawOrderLineEvent[],
  lineId: string,
  station: 'kitchen' | 'bar',
  toState: string,
): string | null {
  const matches = events.filter(
    (e) => e.order_line_id === lineId && e.station === station && e.to_state === toState,
  )
  if (matches.length === 0) return null
  return matches.reduce((latest, e) => (e.occurred_at > latest ? e.occurred_at : latest), matches[0].occurred_at)
}

export function mapRawLinesToKitchenLines(
  lines: RawOrderLine[],
  events: RawOrderLineEvent[],
  tableNumberByOrderId: Record<string, string> = {},
): KitchenLine[] {
  return lines
    .filter((line) => line.route_to === 'unrouted' || line.route_to === 'kitchen' || line.route_to === 'both')
    .map((line) => ({
      id: line.id,
      tableNumber: tableNumberByOrderId[line.order_id] ?? '—',
      waiterName: '', // no waiter-identity column found yet — see schema-assumptions.ts
      itemName: line.name_snapshot,
      quantity: line.quantity,
      station: 'kitchen', // no sub-station column exists yet — see schema-assumptions.ts
      routeTo: line.route_to,
      createdAt: line.created_at,
      cookedAt: null, // no proven third state to distinguish "cooked" from "outstanding" yet
      readyToRunAt:
        line.kitchen_state === DONE ? transitionTimestamp(events, line.id, 'kitchen', DONE) : null,
    }))
}

export function mapRawLinesToBarRounds(
  lines: RawOrderLine[],
  events: RawOrderLineEvent[],
  tableNumberByOrderId: Record<string, string> = {},
): BarRound[] {
  const barLines = lines.filter(
    (line) => line.route_to === 'unrouted' || line.route_to === 'bar' || line.route_to === 'both',
  )

  const orderIds: string[] = []
  const byOrder = new Map<string, RawOrderLine[]>()
  for (const line of barLines) {
    if (!byOrder.has(line.order_id)) {
      orderIds.push(line.order_id)
      byOrder.set(line.order_id, [])
    }
    byOrder.get(line.order_id)!.push(line)
  }

  return orderIds.map((orderId) => {
    const roundLines = byOrder.get(orderId)!
    const first = roundLines[0]

    const routeTo = roundLines.every((line) => line.route_to === 'unrouted')
      ? 'unrouted'
      : first.route_to === 'unrouted'
        ? 'bar'
        : first.route_to

    const allDone = roundLines.every((line) => line.bar_state === DONE)
    const outAt = allDone
      ? roundLines
          .map((line) => transitionTimestamp(events, line.id, 'bar', DONE))
          .filter((t): t is string => t !== null)
          .reduce((earliest: string | null, t) => (earliest === null || t < earliest ? t : earliest), null)
      : null

    return {
      id: orderId,
      tableNumber: tableNumberByOrderId[orderId] ?? '—',
      waiterName: '',
      items: roundLines.map((line) => ({ itemName: line.name_snapshot, quantity: line.quantity })),
      routeTo,
      createdAt: roundLines.reduce(
        (earliest, line) => (line.created_at < earliest ? line.created_at : earliest),
        first.created_at,
      ),
      outAt,
    }
  })
}
