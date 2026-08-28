import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import {
  assertTerminalPairedToStation,
  isStationKind,
  StationPairingMismatchError,
  type StationKind,
} from '@/lib/stations/station-pairing'
import type { LineState } from '@/lib/orders/order-lines'
import { POST as bumpOrderLineState } from '@/app/api/station/order-lines/[lineId]/state/route'

export const dynamic = 'force-dynamic'

/**
 * ONE TAP, MANY LINES — the per-table "all cooked" and the per-round "all out".
 *
 * ============================================================================================
 * WHY THIS IS ONE REQUEST AND NOT N REQUESTS FROM THE CLIENT
 * ============================================================================================
 *
 * A loop of fetches from the screen would give five independent outcomes with no single place to
 * decide what the card should say when three of them work. Whichever one resolved last would win
 * the UI, and a refusal that arrived first would be overwritten by a success that arrived second.
 * The whole reason the per-table control exists is that five taps is wrong; five silently
 * independent results is the same mistake moved into the network layer.
 *
 * ============================================================================================
 * THE CALLER NAMES THE LINES. THAT IS THE POINT, NOT A CONVENIENCE.
 * ============================================================================================
 *
 * The brief: the per-table control "must act on exactly the lines that card is showing for that
 * station". So the body carries the ids the card rendered, not an order id for the server to
 * re-derive a set from. `POST /api/terminal/bar-rounds/[roundId]` takes the other approach — it
 * re-reads every bar-owned line on the order — and the two can disagree: the card was painted from
 * a snapshot, and a line added since is a line the cook never saw and never agreed to bump.
 *
 * ============================================================================================
 * "AND MUST NOT TOUCH ... LINES ALREADY IN A FURTHER STATE"
 * ============================================================================================
 *
 * The single-line contract underneath will happily write 'cooked' over 'ready', because for one
 * deliberate tap that is a legitimate correction. Fanned out across a table it is not: a line the
 * pass ran while the cook was reaching for the button would be dragged BACKWARDS onto the board by
 * a shortcut nobody aimed at it.
 *
 * So this reads each line's current state first and only forwards the ones that are genuinely
 * behind the target. A line already at or past it is reported `skipped`, which is not a failure —
 * it is the correct outcome and the card must not shout about it.
 *
 * A 'voided' line is neither bumped nor quietly skipped: it is refused and named, because a void
 * came from the terminal and somebody looking at that card needs to know the dish is cancelled.
 *
 * ============================================================================================
 * PARTIAL FAILURE IS AN OUTCOME, NOT AN ERROR
 * ============================================================================================
 *
 * Every line's result is returned, always, whether the overall status is 200 or 409. The screen
 * needs the per-line detail to mark the individual rows that did not move; a bare 409 would leave
 * a card that shrank from five rows to two and no way to say why. 409 (not 207) matches
 * app/api/terminal/bar-rounds/[roundId]'s existing ROUND_PARTIALLY_FAILED rather than introducing
 * a second convention for the same event.
 *
 * ROUTE NAME: `batch` is a sibling of the dynamic `[lineId]` segment. Next resolves the static
 * segment first, and a real lineId is a UUID, so nothing can be shadowed by it.
 */

/** The screens' own action vocabulary — the words on the buttons — not the stored states. Same
 *  two the single-line route accepts, plus the bar's, all translated at the door exactly once. */
const ACTION_TO_STATE = {
  cooked: 'cooked',
  ready_to_run: 'ready',
  out: 'ready',
} as const

type Action = keyof typeof ACTION_TO_STATE

/** How far along a line is. Only a strictly larger target may be written by a fan-out. */
const STATE_PROGRESS: Record<LineState, number> = {
  outstanding: 0,
  cooked: 1,
  ready: 2,
  // Not on the scale at all — a void is a different axis and is refused explicitly below.
  voided: -1,
}

/** A wall screen shows one service's worth of lines. Anything past this is not a card's worth of
 *  work, it is a client bug or a script, and fanning it out would be a self-inflicted load test. */
const MAX_LINES_PER_BATCH = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type BatchLineResult = {
  line_id: string
  outcome: 'moved' | 'unchanged' | 'skipped' | 'failed'
  status: number
  code: string | null
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Station screens are not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as {
      station?: unknown
      action?: unknown
      line_ids?: unknown
    }

    const station = String(body.station ?? '').trim().toLowerCase()
    if (!isStationKind(station)) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }

    const action = String(body.action ?? '').trim().toLowerCase()
    if (!(action in ACTION_TO_STATE)) {
      return NextResponse.json({ error: 'Invalid action', code: 'INVALID_ACTION' }, { status: 400 })
    }
    const toState = ACTION_TO_STATE[action as Action] as LineState

    const rawIds = Array.isArray(body.line_ids) ? body.line_ids : null
    if (!rawIds || rawIds.length === 0) {
      return NextResponse.json(
        { error: 'line_ids must be a non-empty array', code: 'INVALID_LINE_IDS' },
        { status: 400 },
      )
    }
    if (rawIds.length > MAX_LINES_PER_BATCH) {
      return NextResponse.json(
        { error: `line_ids may not exceed ${MAX_LINES_PER_BATCH} lines`, code: 'TOO_MANY_LINES' },
        { status: 400 },
      )
    }
    // De-duplicated: the same id twice would produce one real transition and one 'unchanged', and
    // the card would report a phantom no-op it never asked for.
    const lineIds = [...new Set(rawIds.map((id) => String(id)))]
    if (lineIds.some((id) => !UUID.test(id))) {
      return NextResponse.json(
        { error: 'every line_id must be a valid UUID', code: 'INVALID_LINE_IDS' },
        { status: 400 },
      )
    }

    // Pairing is checked for the station the body names, so one route serves both screens without
    // either being able to reach into the other's board.
    try {
      await assertTerminalPairedToStation(supabase, terminal, station as StationKind)
    } catch (err) {
      if (err instanceof StationPairingMismatchError) {
        return NextResponse.json({ error: err.message, code: err.code, pairedTo: err.pairedTo }, { status: 403 })
      }
      throw err
    }

    const stateColumn = station === 'kitchen' ? 'kitchen_state' : 'bar_state'

    const { data: rows, error: readError } = await supabase
      .from('order_lines')
      .select('id, kitchen_state, bar_state')
      .eq('restaurant_id', terminal.restaurantId)
      .in('id', lineIds)

    if (readError) throw readError

    const currentById = new Map<string, LineState | null>()
    for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
      currentById.set(String(row.id), (row[stateColumn] ?? null) as LineState | null)
    }

    const results: BatchLineResult[] = []
    const toForward: string[] = []

    for (const lineId of lineIds) {
      if (!currentById.has(lineId)) {
        // Not this restaurant's line, or gone. Never forwarded — the delegate would 404 anyway, and
        // saying so here keeps a cross-tenant id from reaching a write path at all.
        results.push({ line_id: lineId, outcome: 'failed', status: 404, code: 'LINE_NOT_FOUND' })
        continue
      }
      const current = currentById.get(lineId) ?? null
      if (current === null) {
        // This station does not own the line at all — the other station's half. Refused, not
        // skipped, because the card should never have offered it.
        results.push({ line_id: lineId, outcome: 'failed', status: 409, code: 'STATION_DOES_NOT_OWN_LINE' })
        continue
      }
      if (current === 'voided') {
        results.push({ line_id: lineId, outcome: 'failed', status: 409, code: 'LINE_VOIDED' })
        continue
      }
      if (STATE_PROGRESS[current] >= STATE_PROGRESS[toState]) {
        results.push({ line_id: lineId, outcome: 'skipped', status: 200, code: 'ALREADY_AT_OR_PAST_TARGET' })
        continue
      }
      toForward.push(lineId)
    }

    /**
     * Sequential, not Promise.all. Every one of these writes an append-only audit row through the
     * same handler, and the failure this must not have is a partial write nobody can reconstruct
     * the order of. A table's worth of lines is single digits; the latency is not the constraint.
     */
    for (const lineId of toForward) {
      const delegateReq = new Request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify({ station, to_state: toState }),
      })
      const res = await bumpOrderLineState(delegateReq, { params: Promise.resolve({ lineId }) })
      const resBody = (await res.json().catch(() => null)) as
        | { unchanged?: boolean; code?: string }
        | null

      if (!res.ok) {
        results.push({
          line_id: lineId,
          outcome: 'failed',
          status: res.status,
          code: resBody?.code ?? null,
        })
        continue
      }
      results.push({
        line_id: lineId,
        outcome: resBody?.unchanged ? 'unchanged' : 'moved',
        status: res.status,
        code: null,
      })
    }

    // Preserve the caller's order so the screen can line results up against the rows it rendered.
    const byId = new Map(results.map((r) => [r.line_id, r]))
    const ordered = lineIds.map((id) => byId.get(id)!).filter(Boolean)

    const failed = ordered.filter((r) => r.outcome === 'failed')

    if (failed.length > 0) {
      console.error('[station-lines/batch] some lines in this bump did not move', {
        station,
        action,
        total: ordered.length,
        failed,
      })
      return NextResponse.json(
        {
          ok: false,
          error: 'Some of these lines could not be moved.',
          code: 'BATCH_PARTIALLY_FAILED',
          station,
          action,
          total: ordered.length,
          moved: ordered.filter((r) => r.outcome === 'moved').length,
          results: ordered,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({
      ok: true,
      station,
      action,
      total: ordered.length,
      moved: ordered.filter((r) => r.outcome === 'moved').length,
      results: ordered,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[station-lines/batch] failed:', err)
    return NextResponse.json({ error: 'Failed to record the line events' }, { status: 500 })
  }
}
