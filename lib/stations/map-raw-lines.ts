/**
 * lib/stations/map-raw-lines.ts — maps the REAL GET /api/station/lines response (ADR-005 §5,
 * app/api/station/lines/route.ts) into the KitchenLine / BarRound shapes
 * components/stations renders.
 *
 * REBUILT 2026-08-28. This used to map a raw order_lines/order_line_events table dump against a
 * GUESSED shape (lib/stations/schema-assumptions.ts, now deleted). It maps the real route's own
 * response now — already grouped into one card per order, already filtered to NOT-FINISHED lines
 * for the station that asked, already carrying is_ready/unrouted/shared_with_other_station
 * computed once, server-side, by the same code the write side uses. See lib/stations/types.ts's
 * docblock for what that changes about what these shapes can represent (no 'ready' zone, no
 * per-line transition timestamp).
 *
 * Pure and unit-testable so the mapping is provable independent of the route under it — same
 * intent as before, different input shape.
 */
import type { KitchenLine, BarRound, RouteTo } from '@/lib/stations/types'

export type StationLineDTO = {
  id: string
  name_snapshot: string
  quantity: number
  line_note: string | null
  route_to: RouteTo
  kitchen_state: string | null
  bar_state: string | null
  /** When this station last tapped Cooked. Null while the line is still outstanding. */
  cooked_at?: string | null
  is_ready: boolean
  unrouted: boolean
  shared_with_other_station: boolean
}

export type StationOrderCardDTO = {
  order_id: string
  order_number: string | number | null
  table_number: string | number | null
  order_instructions?: string | null
  placed_at: string | null
  seconds_waiting: number | null
  lines: StationLineDTO[]
}

export type StationLinesResponseDTO = {
  station: 'kitchen' | 'bar'
  orders: StationOrderCardDTO[]
  server_time: string
}

/**
 * GET /api/station/lines already filters kitchen_state to NOT-FINISHED for station=kitchen
 * (excludes 'ready' and 'voided' server-side), so this can only ever legitimately see
 * 'outstanding' or 'cooked'. A value neither of those (a future addition to the vocabulary this
 * mapper has not been taught about yet) falls open to 'outstanding' rather than throwing — the
 * same "fail open, get questioned" posture order-lines.ts's own isStationOutstanding uses.
 */
function toKitchenLineState(raw: string | null): 'outstanding' | 'cooked' {
  return raw === 'cooked' ? 'cooked' : 'outstanding'
}

export function mapStationLinesToKitchenLines(response: StationLinesResponseDTO): KitchenLine[] {
  const out: KitchenLine[] = []
  for (const card of response.orders) {
    for (const line of card.lines) {
      out.push({
        id: line.id,
        orderId: card.order_id,
        // Empty string, not a dash: the LABEL decides how an absent table reads, and a dash baked
        // in here would render as "Table —" wherever it is used. GET /api/station/lines already
        // normalises a zero table number to null, so this is the single absent case.
        tableNumber: card.table_number == null ? '' : String(card.table_number),
        orderNumber: card.order_number,
        itemName: line.name_snapshot,
        quantity: line.quantity,
        lineNote: line.line_note,
        routeTo: line.route_to,
        state: toKitchenLineState(line.kitchen_state),
        placedAt: card.placed_at,
        cookedAt: line.cooked_at ?? null,
        unrouted: line.unrouted,
        sharedWithOtherStation: line.shared_with_other_station,
      })
    }
  }
  return out
}

/**
 * One order card IS one round — GET /api/station/lines already groups by order_id and already
 * scoped every line in it to lines the bar owns (bar_state IS NOT NULL), so no re-grouping is
 * needed here, unlike the old raw-row mapper which had to reconstruct that grouping itself.
 */
export function mapStationLinesToBarRounds(response: StationLinesResponseDTO): BarRound[] {
  return response.orders
    .filter((card) => card.lines.length > 0)
    .map((card) => ({
      id: card.order_id,
      tableNumber: String(card.table_number ?? '—'),
      orderNumber: card.order_number,
      items: card.lines.map((line) => ({
        itemName: line.name_snapshot,
        quantity: line.quantity,
        lineNote: line.line_note,
      })),
      placedAt: card.placed_at,
      unrouted: card.lines.some((line) => line.unrouted),
    }))
}
