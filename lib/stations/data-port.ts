/**
 * feat/station-screens-v1 — fetches the snapshot from GET /api/terminal/station-lines and maps
 * it through lib/stations/map-raw-lines.ts. This file, that route, and
 * lib/stations/map-raw-lines.ts are the three places the wire shape is touched.
 *
 * REBUILT 2026-08-28: GET /api/terminal/station-lines now delegates straight to the real
 * GET /api/station/lines (ADR-005 §5) after its own feature-flag and pairing checks, so the body
 * this fetches is that route's own `{ station, orders, server_time }` shape — see
 * lib/stations/map-raw-lines.ts's StationLinesResponseDTO — not a raw table dump.
 *
 * Fails soft, not hard: a failed fetch returns an empty board rather than crashing the screen,
 * and logs once. `notEnabled` (the flag is off venue-wide) and `notPaired` (this specific
 * terminal isn't paired to this screen, 20260828230000_terminal_station_pairing.sql) are
 * threaded through separately from "empty" and from each other — see StationSnapshot — because
 * each is a distinct configuration fact worth telling staff, not the same silence as a genuinely
 * quiet shift.
 */
import { mapStationLinesToBarRounds, mapStationLinesToKitchenLines, type StationLinesResponseDTO } from '@/lib/stations/map-raw-lines'
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

async function fetchStationLinesResponse(
  authFetch: AuthFetch,
  station: StationKind,
): Promise<{
  response: StationLinesResponseDTO | null
  notEnabled: boolean
  notPaired: boolean
  pairedTo: string | null
}> {
  const response = await authFetch(`/api/terminal/station-lines?station=${station}`)

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; pairedTo?: string | null }
    const notPaired = body.code === 'STATION_NOT_PAIRED'
    return {
      response: null,
      notEnabled: !notPaired,
      notPaired,
      pairedTo: notPaired ? (body.pairedTo ?? null) : null,
    }
  }

  if (!response.ok) {
    warnOnce(await response.text().catch(() => response.statusText))
    return { response: null, notEnabled: false, notPaired: false, pairedTo: null }
  }

  const body = (await response.json()) as StationLinesResponseDTO
  return { response: body, notEnabled: false, notPaired: false, pairedTo: null }
}

export async function fetchInitialKitchenLines(authFetch: AuthFetch): Promise<StationSnapshot<KitchenLine>> {
  const { response, notEnabled, notPaired, pairedTo } = await fetchStationLinesResponse(authFetch, 'kitchen')
  return { items: response ? mapStationLinesToKitchenLines(response) : [], notEnabled, notPaired, pairedTo }
}

export async function fetchInitialBarRounds(authFetch: AuthFetch): Promise<StationSnapshot<BarRound>> {
  const { response, notEnabled, notPaired, pairedTo } = await fetchStationLinesResponse(authFetch, 'bar')
  return { items: response ? mapStationLinesToBarRounds(response) : [], notEnabled, notPaired, pairedTo }
}
