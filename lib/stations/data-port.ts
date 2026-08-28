/**
 * feat/station-screens-v1 — fetches the snapshot from GET /api/terminal/station-lines and maps
 * it through lib/stations/map-raw-lines.ts. This file, that route, and
 * lib/stations/schema-assumptions.ts are the three places order_lines' shape is touched — see
 * schema-assumptions.ts's docblock for what is confirmed vs. still open.
 *
 * Fails soft, not hard: a failed fetch returns an empty board rather than crashing the screen,
 * and logs once. `notEnabled` (the flag is off venue-wide) and `notPaired` (this specific
 * terminal isn't paired to this screen, 20260828230000_terminal_station_pairing.sql) are
 * threaded through separately from "empty" and from each other — see StationSnapshot — because
 * each is a distinct configuration fact worth telling staff, not the same silence as a genuinely
 * quiet shift.
 */
import type { RawOrderLine, RawOrderLineEvent } from '@/lib/stations/schema-assumptions'
import { mapRawLinesToBarRounds, mapRawLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import type { BarRound, KitchenLine } from '@/lib/stations/types'
import type { StationKind } from '@/lib/stations/station-pairing'
import type { AuthFetch } from '@/lib/stations/use-terminal-session'

export type StationSnapshot<T> = {
  items: T[]
  notEnabled: boolean
  notPaired: boolean
  pairedTo: string | null
}

let warned = false
function warnOnce(detail: unknown) {
  if (warned) return
  warned = true
  console.warn('[stations] failed to load station lines — showing an empty board.', detail)
}

async function fetchRawSnapshot(
  authFetch: AuthFetch,
  station: StationKind,
): Promise<{
  lines: RawOrderLine[]
  events: RawOrderLineEvent[]
  tableNumberByOrderId: Record<string, string>
  notEnabled: boolean
  notPaired: boolean
  pairedTo: string | null
}> {
  const response = await authFetch(`/api/terminal/station-lines?station=${station}`)

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; pairedTo?: string | null }
    const notPaired = body.code === 'STATION_NOT_PAIRED'
    return {
      lines: [],
      events: [],
      tableNumberByOrderId: {},
      notEnabled: !notPaired,
      notPaired,
      pairedTo: notPaired ? (body.pairedTo ?? null) : null,
    }
  }

  if (!response.ok) {
    warnOnce(await response.text().catch(() => response.statusText))
    return { lines: [], events: [], tableNumberByOrderId: {}, notEnabled: false, notPaired: false, pairedTo: null }
  }

  const body = (await response.json()) as {
    lines?: RawOrderLine[]
    events?: RawOrderLineEvent[]
    tableNumberByOrderId?: Record<string, string>
  }
  return {
    lines: body.lines ?? [],
    events: body.events ?? [],
    tableNumberByOrderId: body.tableNumberByOrderId ?? {},
    notEnabled: false,
    notPaired: false,
    pairedTo: null,
  }
}

export async function fetchInitialKitchenLines(authFetch: AuthFetch): Promise<StationSnapshot<KitchenLine>> {
  const { lines, events, tableNumberByOrderId, notEnabled, notPaired, pairedTo } = await fetchRawSnapshot(
    authFetch,
    'kitchen',
  )
  return { items: mapRawLinesToKitchenLines(lines, events, tableNumberByOrderId), notEnabled, notPaired, pairedTo }
}

export async function fetchInitialBarRounds(authFetch: AuthFetch): Promise<StationSnapshot<BarRound>> {
  const { lines, events, tableNumberByOrderId, notEnabled, notPaired, pairedTo } = await fetchRawSnapshot(
    authFetch,
    'bar',
  )
  return { items: mapRawLinesToBarRounds(lines, events, tableNumberByOrderId), notEnabled, notPaired, pairedTo }
}
