'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes } from '@/lib/stations/age'
import { buildBarBoard } from '@/lib/stations/grouping'
import type { BarRound } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'

function ageLabel(minutes: number): string {
  return minutes <= 0 ? STATION_COPY.age.justNow : STATION_COPY.age.minutes(minutes)
}

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
    <div
      data-testid="bar-round-card"
      className="rounded-xl border border-[#E9E9E7] bg-white p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[#37352F]">{STATION_COPY.bar.tableLabel(round.tableNumber)}</p>
          <p className="text-xs text-[#6B675F]">{round.waiterName}</p>
        </div>
        <span className="text-xs font-medium tabular-nums text-[#6B675F]" data-testid="bar-round-age">
          {ageLabel(ageMinutes(round.createdAt, now))}
        </span>
      </div>
      <ul className="mt-2 space-y-1 text-sm text-[#37352F]">
        {round.items.map((item, index) => (
          <li key={index}>
            {item.quantity}× {item.itemName}
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

      <div className="grid gap-6 sm:grid-cols-2">
        <section data-testid="bar-in-column">
          <h2 className="mb-3 text-xl font-bold uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.inHeading}
          </h2>
          {board.in.length === 0 ? (
            <p className="text-sm text-[#6B675F]">{STATION_COPY.bar.inEmpty}</p>
          ) : (
            <div className="space-y-3">
              {board.in.map((round) => (
                <RoundCard key={round.id} round={round} now={now} onBumpOut={onBumpOut} />
              ))}
            </div>
          )}
        </section>

        <section data-testid="bar-out-column">
          <h2 className="mb-3 text-xl font-bold uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.outHeading}
          </h2>
          {board.out.length === 0 ? (
            <p className="text-sm text-[#6B675F]">{STATION_COPY.bar.outEmpty}</p>
          ) : (
            <div className="space-y-3">
              {board.out.map((round) => (
                <RoundCard key={round.id} round={round} now={now} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
