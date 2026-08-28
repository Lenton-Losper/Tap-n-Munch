'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, formatAge, worstEscalation } from '@/lib/stations/age'
import { buildBarBoard, readyLineEscalation } from '@/lib/stations/grouping'
import { densityFor, type DensityScale } from '@/lib/stations/board-density'
import type { BumpLines, StationBumpAction } from '@/lib/stations/bump'
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
 * REBUILT 20260829160000 — SAME TWO ZONES AS THE KITCHEN, ONE DELIBERATE DIFFERENCE
 * ============================================================================================
 *
 * Shares components/stations/station-card.tsx and lib/stations/board-density.ts with the kitchen
 * — same tiling, same round geometry, same type floor, same per-line-plus-per-round control
 * shape, same partial-failure behaviour, same two zones in the same order: TO MAKE on top, a
 * pinned Ready ("Waiting for collection") zone below it.
 *
 * A round is not made or collected all at once — "PER LINE, both boards" is a standing ruling
 * this rebuild does not touch — so lib/stations/grouping.ts splits a round's OWN items between
 * the two zones rather than the round as a whole. A table with two drinks poured and one still
 * pending is a real shape: it shows up here as a TO MAKE card carrying its one pending drink and a
 * Ready card carrying its two poured ones, at the same time.
 *
 * ============================================================================================
 * THE ONE DIFFERENCE: TO MAKE STAYS NEUTRAL. WAITING FOR COLLECTION DOES NOT.
 * ============================================================================================
 *
 * The standing ruling — "a warm beer is a smaller problem than a cold steak" — is about the TO
 * MAKE zone specifically, and this rebuild does not overturn it: every TO MAKE card is drawn
 * neutral whatever its age, `escalation={null}` passed explicitly so nobody later reads a missing
 * prop as an oversight, and the zone's own ordering stays plain FIFO rather than sorting by
 * urgency the way every other zone on either board now does — there is nothing to rank a neutral
 * card by.
 *
 * The board rebuild's own new ruling is a DIFFERENT zone: "the waiting-for-collection zone DOES
 * age... a drink sitting uncollected is a different problem from one not yet made." So Waiting for
 * collection ages exactly like the kitchen's Ready zone, on the same clock (readyAt) and the same
 * bands (readyToRunEscalation) — the first age colour the bar screen has ever carried, and it is
 * scoped to the one zone the owner named.
 */

/** An unrouted round has nowhere to be bumped TO until somebody sets a route, so it renders with
 *  no controls at all. Module-level so it is a stable identity across renders. */
const NO_BUMP: BumpLines = async () => ({ ok: true, total: 0, failedLineIds: [] })

function BarRoundCard({
  round,
  now,
  scale,
  zone,
  onBump,
  unrouted = false,
}: {
  round: BarRound
  now: number
  scale: DensityScale
  zone: 'active' | 'ready'
  onBump?: BumpLines
  unrouted?: boolean
}) {
  // Hooks are not optional, so the unrouted case gets NO_BUMP rather than a conditional hook.
  const bump = useCardBump(onBump ?? NO_BUMP)
  const lineIds = round.items.map((item) => item.id)

  const escalation =
    zone === 'ready'
      ? worstEscalation(round.items.map((item) => readyLineEscalation(item.readyAt, round.placedAt, now)))
      : null
  const clock = (item: BarRound['items'][number]) => (zone === 'ready' ? item.readyAt ?? round.placedAt : round.placedAt) ?? ''
  const oldest = Math.max(...round.items.map((item) => ageMinutes(clock(item), now)))

  const action: StationBumpAction = zone === 'ready' ? 'collected' : 'out'
  const buttonLabel = zone === 'ready' ? STATION_COPY.bar.collectedButton : STATION_COPY.bar.outButton
  const allLabel = zone === 'ready' ? STATION_COPY.bar.allCollectedButton : STATION_COPY.bar.allOutButton
  const tone = zone === 'ready' ? 'pass' : 'station'

  return (
    <StationCard
      testId="bar-round-card"
      tableLabel={STATION_COPY.bar.tableLabel(round.tableNumber)}
      ageLabel={formatAge(oldest)}
      escalation={escalation}
      scale={scale}
      headerAction={
        onBump && round.items.length > 1 ? (
          <PerCardButton
            label={allLabel}
            count={round.items.length}
            lineIds={lineIds}
            action={action}
            tone={tone}
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
            buttonLabel={buttonLabel}
            action={action}
            tone={tone}
            bump={bump}
            scale={scale}
            escalation={zone === 'ready' ? readyLineEscalation(item.readyAt, round.placedAt, now) : null}
          />
        ) : (
          <div
            key={item.id}
            data-testid="station-line-row"
            data-escalation="none"
            className={`border-t border-current/15 first:border-t-0 ${scale.rowPadClass}`}
          >
            <p className={`font-bold leading-tight ${scale.itemClass}`}>
              {item.quantity}× {item.itemName}
            </p>
            {item.lineNote ? (
              <p
                data-testid="line-note"
                className={`mt-0.5 inline-block rounded bg-red-100 px-1 font-bold text-red-900 ${scale.noteClass}`}
              >
                ⚠ {item.lineNote}
              </p>
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
  const board = buildBarBoard(rounds, now)
  const activeScale = densityFor(board.active.length)
  const readyScale = densityFor(board.ready.length)
  const cardCount = board.active.length + board.ready.length

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="bar-screen"
      data-density={activeScale.density}
      data-card-count={cardCount}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h1 className="font-serif text-2xl font-bold text-[#37352F]">{STATION_COPY.bar.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/* Measured by tests/e2e/station-board-wall-fit.spec.ts, same as the kitchen's. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="station-board-body">
        {board.unrouted.length > 0 ? (
          <div
            data-testid="unrouted-section"
            className="mb-1.5 shrink-0 rounded-xl border-4 border-red-500 bg-red-50 px-2.5 py-1.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-lg font-black text-red-900">{STATION_COPY.unrouted.heading}</h2>
              <p className="text-sm text-red-800">{STATION_COPY.unrouted.description}</p>
            </div>
            <div className={`mt-1.5 gap-1.5 ${activeScale.columnsClass}`}>
              {board.unrouted.map((round) => (
                <BarRoundCard key={round.id} round={round} now={now} scale={activeScale} zone="active" unrouted />
              ))}
            </div>
          </div>
        ) : null}

        <section className="flex-[65] shrink-0" data-testid="bar-active-section">
          <h2 className="mb-1 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.activeHeading}
          </h2>
          {board.active.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.bar.activeEmpty}</p>
          ) : (
            <div className={`gap-1.5 ${activeScale.columnsClass}`} data-testid="bar-active-grid">
              {board.active.map((round) => (
                <BarRoundCard
                  key={round.id}
                  round={round}
                  now={now}
                  scale={activeScale}
                  zone="active"
                  onBump={onBump}
                />
              ))}
            </div>
          )}
        </section>

        <section
          className="mt-2 flex-[35] shrink-0 border-t-4 border-[#37352F] pt-1.5"
          data-testid="bar-ready-section"
        >
          <h2 className="mb-1 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.readyHeading}
          </h2>
          {board.ready.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.bar.readyEmpty}</p>
          ) : (
            <div className={`gap-1.5 ${readyScale.columnsClass}`} data-testid="bar-ready-grid">
              {board.ready.map((round) => (
                <BarRoundCard
                  key={round.id}
                  round={round}
                  now={now}
                  scale={readyScale}
                  zone="ready"
                  onBump={onBump}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
