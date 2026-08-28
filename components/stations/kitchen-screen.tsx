'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, formatAge, worstEscalation } from '@/lib/stations/age'
import {
  buildKitchenBoard,
  kitchenActiveLineEscalation,
  readyLineEscalation,
  type TableGroup,
} from '@/lib/stations/grouping'
import { densityFor, type DensityScale } from '@/lib/stations/board-density'
import type { BumpLines } from '@/lib/stations/bump'
import type { KitchenLine } from '@/lib/stations/types'
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
 * THE KITCHEN WALL BOARD.
 *
 * ============================================================================================
 * REBUILT 20260829160000 — TWO ZONES, NOT ONE ORDER FOR THREE THINGS
 * ============================================================================================
 *
 * The previous rebuild fixed the WIDTH problem (two cards across a 1920x1080 wall) and left two
 * others standing: finished food sat ABOVE active work, and 'ready' lines could not appear on
 * this screen at all — `GET /api/station/lines` excluded them server-side, so there was nowhere
 * for a finished plate to go once the pass passed it, which is backwards for a chef who needs to
 * know what to make next before what already left.
 *
 * Now there are two real zones, in reading order:
 *
 *   1. ACTIVE ("To make") — everything not yet ready: not started AND already cooked-and-waiting,
 *      merged into ONE list. A table with one plated dish and one unstarted side is one piece of
 *      active work, and the previous split (a "cooked" zone drawn above an "outstanding" zone)
 *      is exactly the ordering the owner reported as backwards.
 *
 *   2. READY, pinned — lines the pass has passed, waiting to be run. Never sits beneath incoming
 *      work: the board's one scrollable element (`station-board-body`) is measured by
 *      tests/e2e/station-board-wall-fit.spec.ts to never actually scroll, so this zone being
 *      "pinned" falls out of that same contract rather than needing position:sticky — it is
 *      always fully on screen because the whole board is.
 *
 * A "Collected" tap (order_line_events 'collected', 20260829160000) clears a line out of this
 * zone — without it a pinned zone never empties, because nothing ever moves a line past 'ready'.
 *
 * ============================================================================================
 * "FIFO BY DEFAULT, BUT OVERDUE RISES VISUALLY" — POSITION, NOT ONLY COLOUR
 * ============================================================================================
 *
 * lib/stations/grouping.ts sorts each zone by worst escalation first, then oldest-first within a
 * tier — see that file's own note on why "rises" is read as a real reorder rather than only a
 * colour change. Age is still carried by colour, per the brief's own words: "not by making a
 * number bigger" — the printed age is the second read, same as before.
 *
 * ============================================================================================
 * PER LINE IS STILL THE DEFAULT. THE PER-TABLE CONTROL IS A SHORTCUT OVER IT.
 * ============================================================================================
 *
 * Every line keeps its own button. A table showing both outstanding and cooked lines gets up to
 * TWO shortcuts — "All cooked" over its outstanding lines, "All ready" over its cooked ones —
 * because those are two different targets and a single blended shortcut would have to guess which
 * one a tap meant. Each shortcut is offered only when its own subset holds more than one line, for
 * the same reason the original rule existed: a subset of one already has its one tap.
 */

/** The clock an active line is judged on — the pass clock once cooked, the ticket clock before. */
function activeLineClock(line: KitchenLine): string {
  return (line.state === 'cooked' ? line.cookedAt ?? line.placedAt : line.placedAt) ?? ''
}

/** The clock a ready line is judged on — how long it has sat waiting to be collected. */
function readyLineClock(line: KitchenLine): string {
  return line.readyAt ?? line.placedAt ?? ''
}

/** One table's active work — not-yet-cooked and cooked-and-waiting lines together. */
function ActiveTableCard({
  group,
  now,
  scale,
  onBump,
}: {
  group: TableGroup
  now: number
  scale: DensityScale
  onBump: BumpLines
}) {
  const bump = useCardBump(onBump)
  const outstandingLines = group.lines.filter((line) => line.state === 'outstanding')
  const cookedLines = group.lines.filter((line) => line.state === 'cooked')
  const allLineIds = group.lines.map((line) => line.id)
  const escalations = group.lines.map((line) => kitchenActiveLineEscalation(line, now))
  const oldest = Math.max(...group.lines.map((line) => ageMinutes(activeLineClock(line), now)))

  return (
    <StationCard
      testId="active-table-card"
      tableLabel={STATION_COPY.kitchen.tableLabel(group.tableNumber)}
      ageLabel={formatAge(oldest)}
      escalation={worstEscalation(escalations)}
      scale={scale}
      headerAction={
        outstandingLines.length > 1 || cookedLines.length > 1 ? (
          <span className="flex shrink-0 items-center gap-1">
            {outstandingLines.length > 1 ? (
              <PerCardButton
                label={STATION_COPY.kitchen.allCookedButton}
                count={outstandingLines.length}
                lineIds={outstandingLines.map((line) => line.id)}
                action="cooked"
                tone="station"
                bump={bump}
                scale={scale}
              />
            ) : null}
            {cookedLines.length > 1 ? (
              <PerCardButton
                label={STATION_COPY.kitchen.allReadyToRunButton}
                count={cookedLines.length}
                lineIds={cookedLines.map((line) => line.id)}
                action="ready_to_run"
                tone="pass"
                bump={bump}
                scale={scale}
              />
            ) : null}
          </span>
        ) : null
      }
      banner={<CardFailureBanner visibleLineIds={allLineIds} bump={bump} scale={scale} />}
    >
      {outstandingLines.map((line) => (
        <StationLineRow
          key={line.id}
          lineId={line.id}
          itemName={line.itemName}
          quantity={line.quantity}
          lineNote={line.lineNote}
          buttonLabel={STATION_COPY.kitchen.cookedButton}
          action="cooked"
          tone="station"
          bump={bump}
          scale={scale}
          escalation={kitchenActiveLineEscalation(line, now)}
        />
      ))}
      {cookedLines.map((line) => (
        <StationLineRow
          key={line.id}
          lineId={line.id}
          itemName={line.itemName}
          quantity={line.quantity}
          lineNote={line.lineNote}
          buttonLabel={STATION_COPY.kitchen.readyToRunButton}
          action="ready_to_run"
          tone="pass"
          bump={bump}
          scale={scale}
          escalation={kitchenActiveLineEscalation(line, now)}
        />
      ))}
    </StationCard>
  )
}

/** One table's Ready plates — passed, waiting to be run. Pinned zone; see the file docblock. */
function ReadyTableCard({
  group,
  now,
  scale,
  onBump,
}: {
  group: TableGroup
  now: number
  scale: DensityScale
  onBump: BumpLines
}) {
  const bump = useCardBump(onBump)
  const lineIds = group.lines.map((line) => line.id)
  const escalations = group.lines.map((line) => readyLineEscalation(line.readyAt, line.placedAt, now))
  const oldest = Math.max(...group.lines.map((line) => ageMinutes(readyLineClock(line), now)))

  return (
    <StationCard
      testId="ready-table-card"
      tableLabel={STATION_COPY.kitchen.tableLabel(group.tableNumber)}
      ageLabel={formatAge(oldest)}
      escalation={worstEscalation(escalations)}
      scale={scale}
      headerAction={
        group.lines.length > 1 ? (
          <PerCardButton
            label={STATION_COPY.kitchen.allCollectedButton}
            count={group.lines.length}
            lineIds={lineIds}
            action="collected"
            tone="pass"
            bump={bump}
            scale={scale}
          />
        ) : null
      }
      banner={<CardFailureBanner visibleLineIds={lineIds} bump={bump} scale={scale} />}
    >
      {group.lines.map((line) => (
        <StationLineRow
          key={line.id}
          lineId={line.id}
          itemName={line.itemName}
          quantity={line.quantity}
          lineNote={line.lineNote}
          buttonLabel={STATION_COPY.kitchen.collectedButton}
          action="collected"
          tone="pass"
          bump={bump}
          scale={scale}
          escalation={readyLineEscalation(line.readyAt, line.placedAt, now)}
        />
      ))}
    </StationCard>
  )
}

export function KitchenScreen({
  lines,
  now,
  connectionState,
  onBump,
}: {
  lines: KitchenLine[]
  now: number
  connectionState: FeedConnectionState
  onBump: BumpLines
}) {
  const board = buildKitchenBoard(lines, now)
  const activeScale = densityFor(board.activeByTable.length)
  const readyScale = densityFor(board.readyByTable.length)
  const cardCount = board.activeByTable.length + board.readyByTable.length

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="kitchen-screen"
      data-density={activeScale.density}
      data-card-count={cardCount}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h1 className="font-serif text-2xl font-bold text-[#37352F]">{STATION_COPY.kitchen.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/*
        THE ONE SCROLLABLE THING, AND IT IS SUPPOSED TO NEVER SCROLL.
        tests/e2e/station-board-wall-fit.spec.ts measures exactly this element at 1920x1080 with the
        twenty-round fixture and fails if scrollHeight exceeds clientHeight. It is `overflow-auto`
        rather than `overflow-hidden` on purpose: if a board ever does exceed the wall, a scrollbar
        is an admission that there is more, and clipping is a lie.
      */}
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
            <div className="mt-1 flex flex-wrap gap-1.5">
              {board.unrouted.map((line) => (
                <div
                  key={line.id}
                  data-testid="unrouted-item"
                  className="flex items-baseline gap-2 rounded-lg border-2 border-red-300 bg-white px-2 py-1"
                >
                  <p className="text-lg font-bold text-red-900">
                    {STATION_COPY.kitchen.tableLabel(line.tableNumber)} — {line.quantity}× {line.itemName}
                  </p>
                  <p className="text-sm font-semibold text-red-700">{STATION_COPY.unrouted.itemNote}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* ACTIVE — roughly the top two-thirds of the board. */}
        <section className="flex-[65] shrink-0" data-testid="active-section">
          <h2 className="mb-1 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.activeHeading}
          </h2>
          {board.activeByTable.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.kitchen.activeEmpty}</p>
          ) : (
            <div className={`gap-1.5 ${activeScale.columnsClass}`} data-testid="active-grid">
              {board.activeByTable.map((group) => (
                <ActiveTableCard
                  key={group.tableNumber}
                  group={group}
                  now={now}
                  scale={activeScale}
                  onBump={onBump}
                />
              ))}
            </div>
          )}
        </section>

        {/* READY, PINNED — always rendered, always below active work, never scrolled out. */}
        <section
          className="mt-2 flex-[35] shrink-0 border-t-4 border-[#37352F] pt-1.5"
          data-testid="ready-section"
        >
          <h2 className="mb-1 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.readyHeading}
          </h2>
          {board.readyByTable.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.kitchen.readyEmpty}</p>
          ) : (
            <div className={`gap-1.5 ${readyScale.columnsClass}`} data-testid="ready-grid">
              {board.readyByTable.map((group) => (
                <ReadyTableCard
                  key={group.tableNumber}
                  group={group}
                  now={now}
                  scale={readyScale}
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
