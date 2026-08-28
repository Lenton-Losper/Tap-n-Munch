'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import {
  ageMinutes,
  formatAge,
  outstandingEscalation,
  readyToRunEscalation,
  worstEscalation,
  type AgeEscalation,
} from '@/lib/stations/age'
import { buildKitchenBoard, type TableGroup } from '@/lib/stations/grouping'
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
 * WHAT CHANGED, AND WHY THE OLD BOARD WAS UNUSABLE AT VOLUME
 * ============================================================================================
 *
 * The rebuild for distance (02dd27c5) got the type sizes right and the layout wrong. Two table
 * cards across a 1920x1080 wall means a twenty-table service runs off the bottom of the screen, and
 * a wall screen nobody walks up to and touches cannot be scrolled — everything below the fold does
 * not exist. The board only had to hold four tables for that to be invisible.
 *
 * Three things follow from "twenty tables, 1920x1080, read from three metres":
 *
 * 1. THE GRID TILES AND WRAPS, AND ITS DENSITY IS A FUNCTION OF LOAD. See
 *    lib/stations/board-density.ts: the board spends the wall on size while it is quiet and buys
 *    columns with type size in three steps as it fills, down to a documented floor. No tier ever
 *    hides, truncates or collapses a line of food.
 *
 * 2. AGE IS CARRIED BY COLOUR. On a twenty-card wall a cook is choosing between cards, not reading
 *    them, and a colour resolves before a two-digit number does. Each card takes the loudest tier
 *    among its own lines (lib/stations/age.ts's worstEscalation) and wears it on the border and as
 *    a body tint. The number stays, as the second read once the card is chosen.
 *
 *    THE TWO ZONES ESCALATE ON DIFFERENT CLOCKS AND DIFFERENT BANDS. A cooked plate ages on how
 *    long it has sat on the pass (0-2/3-5/5+). An outstanding ticket ages on how long the kitchen
 *    has had it, on the deliberately slower bands outstandingEscalation defines — reusing the pass
 *    bands would put every card on a busy board in red inside six minutes, which is the exact
 *    defect the owner photographed on 2026-08-28 and which 9735be9d fixed.
 *
 * 3. THE PASS ZONE IS GROUPED BY TABLE, LIKE THE STATION ZONE. It used to be one card per plate,
 *    which meant a table of five was five cards scattered by age across the grid, and there was no
 *    per-table object for an "all ready to run" control to live on. Each plate keeps its own row,
 *    its own colour and its own button — `data-testid="cooked-card"` is still one plate, not one
 *    table — inside a card that is one table.
 *
 * ============================================================================================
 * PER LINE IS THE DEFAULT. THE PER-TABLE CONTROL IS A SHORTCUT OVER IT, NOT A REPLACEMENT.
 * ============================================================================================
 *
 * Every line has its own button, because a salad and a steak do not finish together. On top of
 * that, a card holding MORE THAN ONE line also gets one control that acts on all of them.
 *
 * It is deliberately not rendered on a single-line card: there the per-line button already IS the
 * one tap, and a second identical-looking control beside it would only raise the question of
 * whether the two do different things.
 *
 * It acts on exactly the ids this card is showing — see lib/stations/bump.ts and
 * app/api/terminal/station-lines/batch/route.ts, which take the list rather than re-deriving one
 * from the order, so the bar's half of the same order and anything already further along are
 * untouched. What the card shows when 3 of 5 succeed is documented on CardFailureBanner.
 */

function lineEscalation(line: KitchenLine, now: number): AgeEscalation {
  return line.state === 'cooked'
    ? readyToRunEscalation(ageMinutes(line.cookedAt ?? line.placedAt ?? '', now))
    : outstandingEscalation(ageMinutes(line.placedAt ?? '', now))
}

/** The clock this line is judged on: the pass clock once it is cooked, the ticket clock before. */
function lineClock(line: KitchenLine): string {
  return (line.state === 'cooked' ? line.cookedAt ?? line.placedAt : line.placedAt) ?? ''
}

/** One table's plates on the pass. Each plate keeps its own colour, button and age. */
function PassTableCard({
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
  const escalations = group.lines.map((line) => lineEscalation(line, now))
  const oldest = Math.max(...group.lines.map((line) => ageMinutes(lineClock(line), now)))

  return (
    <StationCard
      testId="pass-table-card"
      tableLabel={STATION_COPY.kitchen.tableLabel(group.tableNumber)}
      ageLabel={formatAge(oldest)}
      escalation={worstEscalation(escalations)}
      scale={scale}
      headerAction={
        group.lines.length > 1 ? (
          <PerCardButton
            label={STATION_COPY.kitchen.allReadyToRunButton}
            count={group.lines.length}
            lineIds={lineIds}
            action="ready_to_run"
            tone="pass"
            bump={bump}
            scale={scale}
          />
        ) : null
      }
      banner={<CardFailureBanner visibleLineIds={lineIds} bump={bump} scale={scale} />}
    >
      {group.lines.map((line) => (
        <div
          key={line.id}
          data-testid="cooked-card"
          data-escalation={lineEscalation(line, now)}
          className="border-t border-current/15 first:border-t-0"
        >
          <StationLineRow
            lineId={line.id}
            itemName={line.itemName}
            quantity={line.quantity}
            lineNote={line.lineNote}
            buttonLabel={STATION_COPY.kitchen.readyToRunButton}
            action="ready_to_run"
            tone="pass"
            bump={bump}
            scale={scale}
          />
        </div>
      ))}
    </StationCard>
  )
}

/** One table's outstanding work. The only action here is Cooked — Ready to run belongs to a line
 *  already on the pass, which is a different card in a different zone. */
function OutstandingTableCard({
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
  const escalations = group.lines.map((line) => lineEscalation(line, now))
  const oldest = Math.max(...group.lines.map((line) => ageMinutes(line.placedAt ?? '', now)))

  return (
    <StationCard
      testId="outstanding-table-card"
      tableLabel={STATION_COPY.kitchen.tableLabel(group.tableNumber)}
      ageLabel={formatAge(oldest)}
      escalation={worstEscalation(escalations)}
      scale={scale}
      headerAction={
        group.lines.length > 1 ? (
          <PerCardButton
            label={STATION_COPY.kitchen.allCookedButton}
            count={group.lines.length}
            lineIds={lineIds}
            action="cooked"
            tone="station"
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
          buttonLabel={STATION_COPY.kitchen.cookedButton}
          action="cooked"
          tone="station"
          bump={bump}
          scale={scale}
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
  const board = buildKitchenBoard(lines)
  const cardCount = board.cookedByTable.length + board.outstandingByTable.length
  const scale = densityFor(cardCount)

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="kitchen-screen"
      data-density={scale.density}
      data-card-count={cardCount}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h1 className="font-serif text-2xl font-bold text-[#37352F]">{STATION_COPY.kitchen.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/*
        THE ONE SCROLLABLE THING, AND IT IS SUPPOSED TO NEVER SCROLL.
        tests/e2e/station-board-wall-fit.spec.ts measures exactly this element at 1920x1080 with the
        twenty-table fixture and fails if scrollHeight exceeds clientHeight. It is `overflow-auto`
        rather than `overflow-hidden` on purpose: if a board ever does exceed the wall, a scrollbar
        is an admission that there is more, and clipping is a lie.
      */}
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

        <section className="mb-2" data-testid="cooked-section">
          <h2 className="mb-1.5 text-xl font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.cookedHeading}
          </h2>
          {board.cookedByTable.length === 0 ? (
            <p className="text-lg text-[#6B675F]">{STATION_COPY.kitchen.cookedEmpty}</p>
          ) : (
            <div className={`gap-2 ${scale.columnsClass}`} data-testid="cooked-grid">
              {board.cookedByTable.map((group) => (
                <PassTableCard
                  key={group.tableNumber}
                  group={group}
                  now={now}
                  scale={scale}
                  onBump={onBump}
                />
              ))}
            </div>
          )}
        </section>

        <section data-testid="outstanding-section">
          <h2 className="mb-1.5 text-xl font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.outstandingHeading}
          </h2>
          {board.outstandingByTable.length === 0 ? (
            <p className="text-lg text-[#6B675F]">{STATION_COPY.kitchen.outstandingEmpty}</p>
          ) : (
            <div className={`gap-2 ${scale.columnsClass}`} data-testid="outstanding-grid">
              {board.outstandingByTable.map((group) => (
                <OutstandingTableCard
                  key={group.tableNumber}
                  group={group}
                  now={now}
                  scale={scale}
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
