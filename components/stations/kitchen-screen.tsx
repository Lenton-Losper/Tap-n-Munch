'use client'

import { useCallback, useEffect, useRef } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import { ageSeconds, formatElapsedClock, worstEscalation } from '@/lib/stations/age'
import {
  buildKitchenBoard,
  kitchenActiveLineEscalation,
  kitchenReadyRowEscalation,
  type TableGroup,
} from '@/lib/stations/grouping'
import { densityFor, dispatchDensityFor, type DensityScale } from '@/lib/stations/board-density'
import type { BumpLines } from '@/lib/stations/bump'
import type { DispatchRow, KitchenLine } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'
import {
  CardFailureBanner,
  DispatchRowView,
  NotSentStrip,
  PerCardButton,
  StationCard,
  StationLineRow,
  useCardBump,
  useRecentlyCollected,
} from '@/components/stations/station-card'

/**
 * THE KITCHEN WALL BOARD.
 *
 * ============================================================================================
 * SECOND-PASS REDESIGN (20260829) — TWO FIXED SURFACES, NOT TWO SECTIONS THAT SHARE THE SCROLL
 * ============================================================================================
 *
 * Owner's second-pass brief, verbatim: "Both boards, two fixed surfaces: 68% active, 32% ready.
 * ... ACTIVE answers 'what do I make', READY answers 'what can leave right now'." The board is
 * `flex flex-col` with the active section at `flex-[68]` and the ready section at `flex-[32]` —
 * a genuine height split, not a suggestion — inside the SAME never-actually-scrolls container the
 * first rebuild established (`station-board-body`, still measured by
 * tests/e2e/station-board-wall-fit.spec.ts, though that spec's own testids (`active-table-card` /
 * `ready-table-card`) predate this redesign and need the owner's own reconciliation — see this
 * rebuild's report).
 *
 * ============================================================================================
 * READY IS NOW A DISPATCH QUEUE, NOT A GRID OF SHRUNKEN PRODUCTION CARDS
 * ============================================================================================
 *
 * "No production cards. Dense rows... it is a dispatch queue, not a shrunken production card."
 * The Ready zone used to be StationCard-per-table, same chrome as Active. It is now flat
 * DispatchRowView rows straight from `board.readyRows` (lib/stations/grouping.ts) — one row per
 * LINE, table carried inline as a column, not a heading. A table with a ready dish and an
 * unstarted side genuinely appears in BOTH zones now: an Active card for its outstanding line, one
 * Ready row for its finished one. That is the point of tracking state per line, not per table.
 *
 * ============================================================================================
 * NOT SENT IS NOW A STRIP ABOVE THE WHOLE BOARD, NOT A SECTION INSIDE THE SCROLL
 * ============================================================================================
 *
 * "It can never be buried by normal work" is read literally: NotSentStrip renders OUTSIDE
 * `station-board-body` entirely, in its own `shrink-0` row between the header and the two fixed
 * surfaces, so no amount of active or ready content can push it off screen — not "usually stays
 * on top", but structurally cannot be covered.
 *
 * ============================================================================================
 * A COLLECTED ROW IS RECOVERABLE, NOT INSTANT — THE ONE RULING THE OWNER CHANGED FROM THE PROPOSAL
 * ============================================================================================
 *
 * "A waiter who taps the wrong row has no way back... the tap must be recoverable." A collected
 * line leaves GET /api/station/lines' response the moment the server accepts the tap, so this
 * screen keeps its own short-lived memory of "I just told the server to collect this"
 * (`useRecentlyCollected`, station-card.tsx) and renders those rows struck through with Undo
 * alongside whatever `board.readyRows` still reports, until the memory window closes or the row is
 * undone. See `readyDisplayRows` below for exactly how the two lists are merged.
 *
 * ============================================================================================
 * PER LINE IS STILL THE DEFAULT ON THE ACTIVE SURFACE. THE PER-TABLE CONTROL IS A SHORTCUT OVER IT.
 * ============================================================================================
 *
 * Unchanged from the first rebuild: every line keeps its own button; a table showing both
 * outstanding and cooked lines gets up to TWO small shortcuts ("All cooked" / "All ready"), never
 * one blended button that would have to guess which lines a tap meant.
 */

/** The clock an active line is judged on — the pass clock once cooked, the ticket clock before. */
function activeLineClock(line: KitchenLine): string {
  return (line.state === 'cooked' ? line.cookedAt ?? line.placedAt : line.placedAt) ?? ''
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
  // Elapsed stays small and consistent as MM:SS — the second-pass brief's own words. formatAge's
  // unit-scaling ("Xh Ym" / "Nd") is the OLD age display this replaces; formatElapsedClock is a
  // deliberately different, fixed-width function (see age.ts's own note on why both still exist).
  const oldestSeconds = Math.max(...group.lines.map((line) => ageSeconds(activeLineClock(line), now)))

  return (
    <StationCard
      testId="active-table-card"
      tableLabel={STATION_COPY.kitchen.tableLabel(group.tableNumber)}
      ageLabel={formatElapsedClock(oldestSeconds)}
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

  // Destructured once, matching bar-screen.tsx's own pattern -- markCollected/clear are each
  // individually stable (useCallback inside the hook), but the wrapping object useRecentlyCollected
  // returns is a fresh literal every render, which is unstable as a useCallback dependency in a way
  // eslint's exhaustive-deps rule cannot see through a member expression on it.
  const { entries: recentlyCollectedEntries, markCollected, clear: clearRecentlyCollected } = useRecentlyCollected()

  /**
   * Every row `board.readyRows` still reports, as-is, PLUS every locally-remembered "just
   * collected" row that has actually left the server's response — see
   * useRecentlyCollected's own docblock in station-card.tsx and this rebuild's report for why the
   * merge goes this direction (server truth wins whenever it and local memory disagree).
   */
  const extraCollectedRows = Object.values(recentlyCollectedEntries)
    .map((entry) => entry.row)
    .filter((row) => !board.readyRows.some((r) => r.lineId === row.lineId))
  const readyDisplayRows: Array<{ row: DispatchRow; collected: boolean }> = [
    ...board.readyRows.map((row) => ({ row, collected: false })),
    ...extraCollectedRows.map((row) => ({ row, collected: true })),
  ]
  const readyDensity = dispatchDensityFor(readyDisplayRows.length)

  /**
   * The Ready zone's one shared bump instance (same pattern as an Active card's own useCardBump).
   * Wraps `onBump` so a successful 'collected' tap is remembered locally the instant it lands —
   * capturing the row's own data before the next refetch removes it from `board.readyRows`
   * entirely, per the recoverable-tap ruling.
   *
   * `board.readyRows` is read via a ref, synced in an effect rather than depended on directly —
   * it is a brand new array every render (buildKitchenBoard recomputes it), so putting it in
   * useCallback's own dependency list would defeat memoization every render for no benefit; the
   * callback only ever runs from an event handler, strictly after the render/effect that last set
   * the ref, so this stays accurate. Depends on `markCollected` itself, not the whole
   * `recentlyCollected` object (whose own wrapper is a fresh object each render, same reason).
   */
  const readyRowsRef = useRef(board.readyRows)
  useEffect(() => {
    readyRowsRef.current = board.readyRows
  }, [board.readyRows])

  const collectBump = useCallback<BumpLines>(
    async (lineIds, action) => {
      const outcome = await onBump(lineIds, action)
      if (action === 'collected') {
        const succeeded = lineIds.filter((id) => !outcome.failedLineIds.includes(id))
        for (const lineId of succeeded) {
          const row = readyRowsRef.current.find((r) => r.lineId === lineId)
          if (row) markCollected(row)
        }
      }
      return outcome
    },
    [onBump, markCollected],
  )
  const readyBump = useCardBump(collectBump)

  const handleUndo = useCallback(
    (row: DispatchRow) => {
      void onBump([row.lineId], 'ready_to_run').then((outcome) => {
        if (!outcome.failedLineIds.includes(row.lineId)) {
          clearRecentlyCollected(row.lineId)
        }
      })
    },
    [onBump, clearRecentlyCollected],
  )

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="kitchen-screen"
      data-density={activeScale.density}
      data-card-count={board.activeByTable.length}
      data-ready-row-count={readyDisplayRows.length}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h1 className="font-serif text-2xl font-bold text-[#37352F]">{STATION_COPY.kitchen.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/*
        "It can never be buried by normal work" — rendered OUTSIDE the scrollable two-surface area
        entirely, its own shrink-0 row, always the first thing under the header. See the file
        docblock.
      */}
      <NotSentStrip
        items={board.unrouted.map((line) => ({
          lineId: line.id,
          tableNumber: line.tableNumber,
          quantity: line.quantity,
          itemName: line.itemName,
        }))}
        tableLabel={STATION_COPY.kitchen.tableLabel}
      />

      {/*
        THE TWO FIXED SURFACES, AND THE WHOLE THING IS SUPPOSED TO NEVER SCROLL.
        tests/e2e/station-board-wall-fit.spec.ts measures exactly this element at 1920x1080 and
        fails if scrollHeight exceeds clientHeight — its own testids predate this redesign's
        Ready-as-rows layout and need reconciling, see this rebuild's report. `overflow-auto`
        rather than `overflow-hidden` is deliberate: if a board ever does exceed the wall, a
        scrollbar admits there is more, and clipping would be a lie.
      */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col" data-testid="station-board-body">
        {/*
          ACTIVE — a genuine 68% of the two-surface height, not a suggestion. `min-h-0` is
          load-bearing: without it a flex child refuses to shrink below its content's natural
          size, which is exactly what let a full Active grid push Ready off the bottom of a
          1920x1080 screen the first time this was measured. `overflow-y-auto` on the GRID (not
          the section) is the same honesty rule the old single-surface board used: if the density
          system ever undersizes a busy service, THIS surface admits it with its own scrollbar
          rather than stealing Ready's fixed share of the wall.
        */}
        <section className="flex min-h-0 flex-[68] flex-col" data-testid="active-section">
          <h2 className="mb-1 shrink-0 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.activeHeading}
          </h2>
          {board.activeByTable.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.kitchen.activeEmpty}</p>
          ) : (
            <div
              className={`min-h-0 flex-1 overflow-y-auto gap-1.5 ${activeScale.columnsClass}`}
              data-testid="active-grid"
            >
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

        {/* READY, PINNED — a genuine 32% of the two-surface height, ALWAYS fully present
            regardless of Active's content (see the note above — that is what min-h-0 on Active
            guarantees). "What can leave right now" — a dense dispatch queue of rows, not cards. */}
        <section
          className="mt-2 flex min-h-0 flex-[32] flex-col border-t-4 border-[#37352F] pt-1.5"
          data-testid="ready-section"
          data-ready-density={readyDensity.density}
        >
          <h2 className="mb-1 shrink-0 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.kitchen.readyHeading}
          </h2>
          {readyDisplayRows.length === 0 ? (
            <p className="text-base text-[#6B675F]">{STATION_COPY.kitchen.readyEmpty}</p>
          ) : (
            <div
              className={`min-h-0 flex-1 overflow-y-auto gap-1 ${readyDensity.columnsClass}`}
              data-testid="ready-dispatch-list"
            >
              {readyDisplayRows.map(({ row, collected }) => (
                <div key={row.lineId} className="mb-1 break-inside-avoid">
                  <DispatchRowView
                    row={row}
                    now={now}
                    escalation={kitchenReadyRowEscalation(row, now)}
                    scale={readyDensity}
                    tableLabel={STATION_COPY.kitchen.tableLabel}
                    readyWord={STATION_COPY.dispatch.readyWord}
                    action="collected"
                    actionLabel={STATION_COPY.kitchen.collectedButton}
                    tone="pass"
                    bump={readyBump}
                    collected={collected}
                    undoLabel={STATION_COPY.dispatch.undoButton}
                    onUndo={collected ? () => handleUndo(row) : undefined}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
