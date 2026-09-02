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
 * and logs once.
 *
 * ============================================================================================
 * WHY A FAULT, AND NOT TWO BOOLEANS (#370)
 * ============================================================================================
 *
 * This used to return `notEnabled` and `notPaired`, computed as:
 *
 *     const notPaired = body.code === 'STATION_NOT_PAIRED'
 *     return { notEnabled: !notPaired, ... }
 *
 * `notEnabled` was therefore never a reading of the flag. It was "some other 403 arrived", and it
 * rendered as "station screens are not turned on yet -- ask whoever manages this venue to enable
 * them". Four different faults produced it, including a screen missing `orders:read`, which has
 * nothing to do with the venue's settings at all.
 *
 * Now the code on the wire chooses the state, and anything unrecognised becomes 'unknown' rather
 * than a specific diagnosis -- see lib/stations/faults.ts. A NON-403 failure is 'unknown' too:
 * rendering an empty board for a 500 is the same defect wearing a different hat, because a board
 * that is empty because it broke looks exactly like a board that is empty because the shift is
 * quiet.
 */
import { mapStationLinesToBarRounds, mapStationLinesToKitchenLines, type StationLinesResponseDTO } from '@/lib/stations/map-raw-lines'
import type { BarRound, KitchenLine } from '@/lib/stations/types'
import type { StationKind } from '@/lib/stations/station-pairing'
import type { AuthFetch } from '@/lib/stations/use-terminal-session'
import { stationFaultFromCode, type StationFault } from '@/lib/stations/faults'

export type StationSnapshot<T> = {
  items: T[]
  /** null when the board loaded. Otherwise the one fault to render. */
  fault: StationFault | null
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
  fault: StationFault | null
  pairedTo: string | null
}> {
  const response = await authFetch(`/api/terminal/station-lines?station=${station}`)

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; pairedTo?: string | null }
    const fault = stationFaultFromCode(body.code)
    return {
      response: null,
      fault,
      // Only the pairing fault carries this, and only it renders it.
      pairedTo: fault === 'not_paired' ? (body.pairedTo ?? null) : null,
    }
  }

  if (!response.ok) {
    warnOnce(await response.text().catch(() => response.statusText))
    return { response: null, fault: 'unknown', pairedTo: null }
  }

  const body = (await response.json()) as StationLinesResponseDTO
  return { response: body, fault: null, pairedTo: null }
}

export async function fetchInitialKitchenLines(authFetch: AuthFetch): Promise<StationSnapshot<KitchenLine>> {
  const { response, fault, pairedTo } = await fetchStationLinesResponse(authFetch, 'kitchen')
  return { items: response ? mapStationLinesToKitchenLines(response) : [], fault, pairedTo }
}

export async function fetchInitialBarRounds(authFetch: AuthFetch): Promise<StationSnapshot<BarRound>> {
  const { response, fault, pairedTo } = await fetchStationLinesResponse(authFetch, 'bar')
  return { items: response ? mapStationLinesToBarRounds(response) : [], fault, pairedTo }
}
