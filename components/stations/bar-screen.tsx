'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, formatAge } from '@/lib/stations/age'
import { buildBarBoard } from '@/lib/stations/grouping'
import type { BarRound } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'

/**
 * Shared with the kitchen board — see lib/stations/age.ts. The bar had the identical unbounded
 * `${n} min` and would have printed the same unreadable "12877 min" on an abandoned round.
 */
const ageLabel = formatAge

function RoundCard({
  round,
  now,
  onBumpOut,
  unrouted = false,
}: {
  round: BarRound
  now: number
  onBumpOut?: (roundId: string) => void
  unrouted?: boolean
}) {
  // Deliberately neutral styling regardless of age — no escalation on the bar side, per the brief.
  return (
    <div data-testid="bar-round-card" className="rounded-xl border border-[#E9E9E7] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold text-[#37352F]">{STATION_COPY.bar.tableLabel(round.tableNumber)}</p>
        <span className="text-xs font-medium tabular-nums text-[#6B675F]" data-testid="bar-round-age">
          {ageLabel(ageMinutes(round.placedAt ?? '', now))}
        </span>
      </div>
      <ul className="mt-2 space-y-1 text-sm text-[#37352F]">
        {round.items.map((item, index) => (
          <li key={index}>
            {item.quantity}× {item.itemName}
            {item.lineNote ? <span className="ml-2 italic text-[#6B675F]">{item.lineNote}</span> : null}
          </li>
        ))}
      </ul>
      {unrouted ? (
        <p className="mt-2 text-xs font-medium text-red-700">{STATION_COPY.unrouted.itemNote}</p>
      ) : null}
      {onBumpOut ? (
        <button
          type="button"
          onClick={() => onBumpOut(round.id)}
          className="mt-3 w-full rounded-lg bg-[#FF6B35] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#e85f2f]"
        >
          {STATION_COPY.bar.outButton}
        </button>
      ) : null}
    </div>
  )
}

/**
 * REBUILT 2026-08-28 for the real four-state model. The old two-column IN | OUT layout is gone:
 * GET /api/station/lines excludes a round the instant its bar_state reaches 'ready' (the same
 * NOT-FINISHED filter that removes a kitchen line once it is passed — see
 * lib/stations/types.ts's docblock), so a round this screen just tapped Out leaves the very next
 * fetch's response and there is nothing left to populate an OUT archive with. Rendering one
 * anyway would mean fabricating client-only state that no other terminal, and no refresh of this
 * one, would agree with — worse than not having the column. See the report this rebuild shipped
 * with for the full reasoning.
 *
 * So this is now a single IN queue. Tapping Out fires the one bump (now to_state: 'ready',
 * directly — no 'cooked' step for the bar, see app/api/terminal/bar-rounds/[roundId]/route.ts's
 * own docblock) and the round disappears from this list on the next refetch, the same way a
 * kitchen line disappears once the pass runs it.
 */
export function BarScreen({
  rounds,
  now,
  connectionState,
  onBumpOut,
}: {
  rounds: BarRound[]
  now: number
  connectionState: FeedConnectionState
  onBumpOut: (roundId: string) => void
}) {
  const board = buildBarBoard(rounds)

  return (
    <div className="min-h-screen bg-[#FAFAF8] p-4 sm:p-6" data-testid="bar-screen">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-[#37352F]">{STATION_COPY.bar.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {board.unrouted.length > 0 ? (
        <div
          data-testid="unrouted-section"
          className="mb-6 rounded-2xl border-2 border-red-400 bg-red-50 p-4"
        >
          <h2 className="text-lg font-bold text-red-900">{STATION_COPY.unrouted.heading}</h2>
          <p className="mt-1 text-sm text-red-800">{STATION_COPY.unrouted.description}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {board.unrouted.map((round) => (
              <RoundCard key={round.id} round={round} now={now} unrouted />
            ))}
          </div>
        </div>
      ) : null}

      <section data-testid="bar-in-section">
        <h2 className="mb-3 text-xl font-bold uppercase tracking-wide text-[#37352F]">{STATION_COPY.bar.inHeading}</h2>
        {board.in.length === 0 ? (
          <p className="text-sm text-[#6B675F]">{STATION_COPY.bar.inEmpty}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {board.in.map((round) => (
              <RoundCard key={round.id} round={round} now={now} onBumpOut={onBumpOut} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
