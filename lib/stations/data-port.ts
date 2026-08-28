/**
 * feat/station-screens-v1 — fetches the snapshot from GET /api/terminal/station-lines and maps
 * it through lib/stations/map-raw-lines.ts. This file, that route, and
 * lib/stations/schema-assumptions.ts are the three places order_lines' shape is touched — see
 * schema-assumptions.ts's docblock for what is confirmed vs. still open.
 *
 * Fails soft, not hard: a failed fetch returns an empty board rather than crashing the screen,
 * and logs once. A `notEnabled` flag is threaded through separately from "empty" — see
 * StationSnapshot — because stationScreensEnabled being off (20260828220000) is a configuration
 * fact worth telling staff, not the same silence as a genuinely quiet shift.
 */
import type { RawOrderLine, RawOrderLineEvent } from '@/lib/stations/schema-assumptions'
import { mapRawLinesToBarRounds, mapRawLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import type { BarRound, KitchenLine } from '@/lib/stations/types'
import type { AuthFetch } from '@/lib/stations/use-terminal-session'

export type StationSnapshot<T> = {
  items: T[]
  notEnabled: boolean
}

let warned = false
function warnOnce(detail: unknown) {
  if (warned) return
  warned = true
  console.warn('[stations] failed to load station lines — showing an empty board.', detail)
}

async function fetchRawSnapshot(authFetch: AuthFetch): Promise<{
  lines: RawOrderLine[]
  events: RawOrderLineEvent[]
  tableNumberByOrderId: Record<string, string>
  notEnabled: boolean
}> {
  const response = await authFetch('/api/terminal/station-lines')

  if (response.status === 403) {
    return { lines: [], events: [], tableNumberByOrderId: {}, notEnabled: true }
  }

  if (!response.ok) {
    warnOnce(await response.text().catch(() => response.statusText))
    return { lines: [], events: [], tableNumberByOrderId: {}, notEnabled: false }
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
  }
}

export async function fetchInitialKitchenLines(authFetch: AuthFetch): Promise<StationSnapshot<KitchenLine>> {
  const { lines, events, tableNumberByOrderId, notEnabled } = await fetchRawSnapshot(authFetch)
  return { items: mapRawLinesToKitchenLines(lines, events, tableNumberByOrderId), notEnabled }
}

export async function fetchInitialBarRounds(authFetch: AuthFetch): Promise<StationSnapshot<BarRound>> {
  const { lines, events, tableNumberByOrderId, notEnabled } = await fetchRawSnapshot(authFetch)
  return { items: mapRawLinesToBarRounds(lines, events, tableNumberByOrderId), notEnabled }
}
