/**
 * lib/stations/bump.ts — the one thing both screens do to the world, and the one shape they get
 * back.
 *
 * ============================================================================================
 * WHY PER-LINE AND PER-TABLE ARE THE SAME CALL
 * ============================================================================================
 *
 * Per line is the default: a salad and a steak do not finish together, and the board has to know
 * which is which. The per-table shortcut exists on top of that, for the table whose whole ticket
 * lands at once. Those are two controls, but they are ONE operation with a different sized list —
 * so they go down one path, and a single tap that is refused reports itself exactly the same way a
 * table of five reports two refusals.
 *
 * The alternative (a fire-and-forget `onMarkCooked(lineId)` for one line, a different call for
 * many) is what was here before, and it meant a per-line tap that the server refused produced no
 * visible effect at all: the line stayed on the board, and the cook's only signal was that tapping
 * it again also did nothing.
 *
 * ============================================================================================
 * THE OUTCOME IS DELIBERATELY NOT A BOOLEAN
 * ============================================================================================
 *
 * `failedLineIds` is what lets a card mark the individual rows that would not move rather than
 * greying out the whole table. `skipped` (already at or past the target) is NOT a failure and is
 * not in it — that is the correct outcome for a line the pass ran a second before the tap landed,
 * and shouting about it would train staff to ignore the marker.
 */
import type { StationKind } from '@/lib/stations/station-pairing'

/** The buttons' own vocabulary. NOT states — see app/api/terminal/station-lines/batch/route.ts,
 *  which is the single place these translate into 'cooked' / 'ready'. Never 'ready_to_run' as a
 *  stored value: the real vocabulary is outstanding / cooked / ready / voided. */
export type StationBumpAction = 'cooked' | 'ready_to_run' | 'out'

export type StationBumpOutcome = {
  /** True when nothing was refused. A batch of skips is still ok. */
  ok: boolean
  /** How many lines the caller asked about, including skips. */
  total: number
  /** Exactly the lines that would not move. Empty on success. */
  failedLineIds: string[]
}

type BatchResponse = {
  ok?: boolean
  total?: number
  results?: Array<{ line_id: string; outcome: string }>
}

export type BumpLines = (lineIds: string[], action: StationBumpAction) => Promise<StationBumpOutcome>

/**
 * A transport failure is reported as EVERY line failing, not as a success.
 *
 * A wall screen that loses its network shows a card that never changes; if this returned ok on a
 * thrown fetch the card would clear its own marker and the kitchen would believe five plates were
 * passed. Failing closed leaves the marker up, and the lines are still on the board because the
 * refetch never removed them, which is the truth.
 */
export async function postStationBump(
  authFetch: (input: string, init?: RequestInit) => Promise<Response>,
  station: StationKind,
  lineIds: string[],
  action: StationBumpAction,
): Promise<StationBumpOutcome> {
  const allFailed: StationBumpOutcome = { ok: false, total: lineIds.length, failedLineIds: [...lineIds] }
  try {
    const response = await authFetch('/api/terminal/station-lines/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station, action, line_ids: lineIds }),
    })

    const body = (await response.json().catch(() => null)) as BatchResponse | null

    // A refusal before any fan-out (bad station, unpaired screen, flag off) has no per-line
    // results. Every line is unmoved, and saying so is more use than an empty failure list.
    if (!body?.results) {
      return response.ok ? { ok: true, total: lineIds.length, failedLineIds: [] } : allFailed
    }

    const failedLineIds = body.results.filter((r) => r.outcome === 'failed').map((r) => r.line_id)
    return {
      ok: failedLineIds.length === 0,
      total: body.total ?? lineIds.length,
      failedLineIds,
    }
  } catch {
    return allFailed
  }
}
