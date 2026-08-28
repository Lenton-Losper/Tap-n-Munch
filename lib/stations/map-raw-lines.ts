/**
 * lib/stations/map-raw-lines.ts — maps the REAL GET /api/station/lines response (ADR-005 §5,
 * app/api/station/lines/route.ts) into the KitchenLine / BarRound shapes
 * components/stations renders.
 *
 * REBUILT 20260829160000 for the pinned Ready zone. Maps the real route's own response —
 * already grouped into one card per order, already filtered to NOT-COLLECTED lines for the
 * station that asked, already carrying is_ready/cooked_at/ready_at/unrouted/
 * shared_with_other_station computed once, server-side, by the same code the write side uses.
 * See lib/stations/types.ts's docblock for what changed: 'ready' lines now reach this mapper
 * (they used to be filtered out before it ever ran), and every line carries a second clock.
 *
 * Pure and unit-testable so the mapping is provable independent of the route under it.
 */
import type { KitchenLine, BarRound, RouteTo, KitchenLineState, BarLineState } from '@/lib/stations/types'

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
  /** When this station's half reached 'ready'. Null before then. */
  ready_at?: string | null
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
 * GET /api/station/lines filters to NOT-COLLECTED for the station that asked (excludes
 * 'collected' and 'voided' server-side), so this can only ever legitimately see 'outstanding',
 * 'cooked' or 'ready'. A value none of those (a future addition to the vocabulary this mapper has
 * not been taught about yet) falls open to 'outstanding' rather than throwing — the same "fail
 * open, get questioned" posture order-lines.ts's own isStationOutstanding uses.
 */
function toLineState(raw: string | null): KitchenLineState {
  if (raw === 'cooked') return 'cooked'
  if (raw === 'ready') return 'ready'
  return 'outstanding'
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
        state: toLineState(line.kitchen_state),
        placedAt: card.placed_at,
        cookedAt: line.cooked_at ?? null,
        readyAt: line.ready_at ?? null,
        unrouted: line.unrouted,
        sharedWithOtherStation: line.shared_with_other_station,
      })
    }
  }
  return out
}

function toBarLineState(raw: string | null): BarLineState {
  return toLineState(raw)
}

/**
 * One order card IS one round — GET /api/station/lines already groups by order_id and already
 * scoped every line in it to lines the bar owns (bar_state IS NOT NULL), so no re-grouping is
 * needed here.
 */
export function mapStationLinesToBarRounds(response: StationLinesResponseDTO): BarRound[] {
  return response.orders
    .filter((card) => card.lines.length > 0)
    .map((card) => ({
      id: card.order_id,
      /**
       * Empty string, never a dash — the SAME rule the kitchen mapper above follows, and it was
       * missed here when defect 2 was fixed on 2026-08-28. `?? '—'` meant an order with no table
       * rendered "Table —" on the bar wall, which is precisely the "reads as a broken screen"
       * failure the ruling exists to prevent; STATION_COPY.bar.tableLabel('') has said "No table"
       * since that commit and nothing was ever reaching it.
       */
      tableNumber: card.table_number == null ? '' : String(card.table_number),
      orderNumber: card.order_number,
      items: card.lines.map((line) => ({
        // Carried so the bar can bump ONE drink — see BarRoundItem's own note.
        id: line.id,
        itemName: line.name_snapshot,
        quantity: line.quantity,
        lineNote: line.line_note,
        state: toBarLineState(line.bar_state),
        cookedAt: line.cooked_at ?? null,
        readyAt: line.ready_at ?? null,
      })),
      placedAt: card.placed_at,
      unrouted: card.lines.some((line) => line.unrouted),
    }))
}
