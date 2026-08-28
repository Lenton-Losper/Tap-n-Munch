'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, formatAge } from '@/lib/stations/age'
import { buildBarBoard } from '@/lib/stations/grouping'
import { densityFor, type DensityScale } from '@/lib/stations/board-density'
import type { BumpLines } from '@/lib/stations/bump'
import type { BarRound } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'
import {
  CardFailureBanner,
  PerCardButton,
  StationCard,
  StationLineRow,
  useCardBump,
} from '@/components/stations/station-card'

/**
 * THE BAR WALL BOARD.
 *
 * ============================================================================================
 * THIS SCREEN WAS LEFT BEHIND, AND THAT WAS THE DEFECT
 * ============================================================================================
 *
 * When the kitchen was rebuilt for distance (02dd27c5) this file kept 14px item text, a 1px border,
 * `text-xs` ages and a fixed three-across grid. One person reads both boards during one service.
 * Two boards drawn to two different scales means everything learned on one — where the table number
 * is, how big a tappable thing is, what a border means — is wrong on the other.
 *
 * It now shares components/stations/station-card.tsx and lib/stations/board-density.ts with the
 * kitchen: same tiling, same card geometry, same type floor, same per-line-plus-per-card control
 * shape, same partial-failure behaviour.
 *
 * ============================================================================================
 * WITH ONE DELIBERATE DIFFERENCE: THERE IS STILL NO ESCALATION HERE
 * ============================================================================================
 *
 * The standing ruling is "a warm beer is a smaller problem than a cold steak" — bar age is
 * display-only. The tiling rebuild did NOT overturn it and must not be read as having done so:
 * every card on this board is drawn neutral whatever its age, and the age number is the only age
 * signal.
 *
 * ON THE RECORD, because the rebuild is the first thing to make it cost something: at twenty rounds
 * a neutral board cannot be triaged by colour the way the kitchen's can, so the only way to find the
 * oldest round is to read twenty numbers — which is the exact reading task the kitchen side stopped
 * asking of a cook. That is a consequence worth the owner ruling on, not a bug to fix here, and the
 * ruling stays in place until they do. `escalation={null}` is passed EXPLICITLY rather than omitted
 * so nobody later reads a missing prop as an oversight.
 */
/** An unrouted round has nowhere to be bumped TO until somebody sets a route, so it renders with
 *  no controls at all. Module-level so it is a stable identity across renders. */
const NO_BUMP: BumpLines = async () => ({ ok: true, total: 0, failedLineIds: [] })

function BarRoundCard({
  round,
  now,
  scale,
  onBump,
  unrouted = false,
}: {
  round: BarRound
  now: number
  scale: DensityScale
  onBump?: BumpLines
  unrouted?: boolean
}) {
  // Hooks are not optional, so the unrouted case gets NO_BUMP rather than a conditional hook.
  const bump = useCardBump(onBump ?? NO_BUMP)
  const lineIds = round.items.map((item) => item.id)

  return (
    <StationCard
      testId="bar-round-card"
      tableLabel={STATION_COPY.bar.tableLabel(round.tableNumber)}
      ageLabel={formatAge(ageMinutes(round.placedAt ?? '', now))}
      escalation={null}
      scale={scale}
      headerAction={
        onBump && round.items.length > 1 ? (
          <PerCardButton
            label={STATION_COPY.bar.allOutButton}
            count={round.items.length}
            lineIds={lineIds}
            action="out"
            tone="station"
            bump={bump}
            scale={scale}
          />
        ) : null
      }
      banner={onBump ? <CardFailureBanner visibleLineIds={lineIds} bump={bump} scale={scale} /> : null}
    >
      {round.items.map((item) =>
        onBump ? (
          <StationLineRow
            key={item.id}
            lineId={item.id}
            itemName={item.itemName}
            quantity={item.quantity}
            lineNote={item.lineNote}
            buttonLabel={STATION_COPY.bar.outButton}
            action="out"
            tone="station"
            bump={bump}
            scale={scale}
          />
        ) : (
          <div
            key={item.id}
            data-testid="station-line-row"
            className={`border-t border-current/15 first:border-t-0 ${scale.rowPadClass}`}
          >
            <p className={`font-bold leading-tight ${scale.itemClass}`}>
              {item.quantity}× {item.itemName}
            </p>
            {item.lineNote ? (
              <p className={`mt-0.5 font-medium opacity-70 ${scale.noteClass}`}>{item.lineNote}</p>
            ) : null}
          </div>
        ),
      )}
      {unrouted ? (
        <p className={`mt-1 font-semibold text-red-700 ${scale.noteClass}`}>{STATION_COPY.unrouted.itemNote}</p>
      ) : null}
    </StationCard>
  )
}

/**
 * A single IN queue — see this file's history and lib/stations/types.ts's docblock: a round that
 * reaches 'ready' leaves GET /api/station/lines' response entirely, so there is nothing left to
 * populate an OUT archive with and rendering one would mean fabricating client-only state.
 */
export function BarScreen({
  rounds,
  now,
  connectionState,
  onBump,
}: {
  rounds: BarRound[]
  now: number
  connectionState: FeedConnectionState
  onBump: BumpLines
}) {
  const board = buildBarBoard(rounds)
  const cardCount = board.in.length + board.unrouted.length
  const scale = densityFor(cardCount)

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="bar-screen"
      data-density={scale.density}
      data-card-count={cardCount}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h1 className="font-serif text-2xl font-bold text-[#37352F]">{STATION_COPY.bar.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/* Measured by tests/e2e/station-board-wall-fit.spec.ts, same as the kitchen's. */}
      <div className="min-h-0 flex-1 overflow-auto" data-testid="station-board-body">
        {board.unrouted.length > 0 ? (
          <div
            data-testid="unrouted-section"
            className="mb-2 rounded-xl border-4 border-red-500 bg-red-50 px-2.5 py-1.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-lg font-black text-red-900">{STATION_COPY.unrouted.heading}</h2>
              <p className="text-sm text-red-800">{STATION_COPY.unrouted.description}</p>
            </div>
            <div className={`mt-1.5 gap-2 ${scale.columnsClass}`}>
              {board.unrouted.map((round) => (
                <BarRoundCard key={round.id} round={round} now={now} scale={scale} unrouted />
              ))}
            </div>
          </div>
        ) : null}

        <section data-testid="bar-in-section">
          <h2 className="mb-1.5 text-xl font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.inHeading}
          </h2>
          {board.in.length === 0 ? (
            <p className="text-lg text-[#6B675F]">{STATION_COPY.bar.inEmpty}</p>
          ) : (
            <div className={`gap-2 ${scale.columnsClass}`} data-testid="bar-in-grid">
              {board.in.map((round) => (
                <BarRoundCard key={round.id} round={round} now={now} scale={scale} onBump={onBump} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
