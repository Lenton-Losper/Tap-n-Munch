'use client'

import { useCallback, useEffect, useRef } from 'react'
import { STATION_COPY, orderContextLabel, orderIdentifier } from '@/lib/stations/copy'
import { StationVenueHeader } from '@/components/stations/station-venue-header'
import { ageSeconds, formatMinutesShort } from '@/lib/stations/age'
import { barActiveLineEscalation, barReadyRowEscalation, buildBarBoard } from '@/lib/stations/grouping'
import { densityFor, dispatchDensityFor, type DensityScale } from '@/lib/stations/board-density'
import type { BumpLines } from '@/lib/stations/bump'
import type { BarRound, DispatchRow } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'
import {
  CardFailureBanner,
  DispatchRowView,
  NotSentStrip,
  ReadySection,
  OlderUnresolvedSection,
  PerCardButton,
  StationCard,
  StationLineRow,
  useCardBump,
  useRecentlyCollected,
} from '@/components/stations/station-card'

/**
 * THE BAR WALL BOARD.
 *
 * ============================================================================================
 * SECOND-PASS REDESIGN (20260829) — SAME SYSTEM AS THE KITCHEN, ONE STATION'S LINES
 * ============================================================================================
 *
 * "Bar is not a variant of kitchen - it is the same system with a different station's lines and a
 * softer ready escalation." Two fixed surfaces (68% active / 32% ready) inside
 * `station-board-body`, a full-width NOT SENT strip rendered OUTSIDE that scrollable area so
 * nothing can ever bury it, and a flat, dense Ready dispatch queue instead of the first pass's
 * grouped Ready cards — see lib/stations/grouping.ts and lib/stations/types.ts's own docblocks for
 * why Ready is DispatchRow[], not BarRound[], and components/stations/station-card.tsx for the
 * shared NotSentStrip / DispatchRowView / useRecentlyCollected primitives this board is built out
 * of, same as the kitchen.
 *
 * ============================================================================================
 * TO MAKE AGES AGAIN, ON ITS OWN (LATER) BANDS — READY AGES TOO, ON ITS OWN (SOFTER) BANDS
 * ============================================================================================
 *
 * Both bar zones now sort and colour by urgency, same as every zone on either board (see
 * lib/stations/grouping.ts's module docblock on the 20260829 reversal of "bar stays neutral"). The
 * STAKES argument that motivated the original neutral ruling still holds — it just stopped meaning
 * "no colour" once a bartender had to read a dozen identical white cards to find the oldest one.
 * TO MAKE uses barActiveLineEscalation's later-than-kitchen bands; Waiting for collection uses
 * barReadyRowEscalation's own softer-than-kitchen bands. "The consequence of a waiting drink is
 * lower than a waiting plate" is now expressed as WHICH BANDS, not as an absence of colour.
 *
 * ============================================================================================
 * "ALL OUT" STAYS THE BAR'S OWN ACTION — NO NEW `cooked` SUB-STATE ADDED
 * ============================================================================================
 *
 * The brief's "an 'All cooked' convenience action may update every outstanding bar line in that
 * round" is read as the KIND of per-round shortcut the kitchen has, described in kitchen
 * vocabulary out of habit — not a literal instruction to give the bar a `cooked` intermediate
 * state. The bar's own tap has always gone straight outstanding -> ready (`out`), a deliberate
 * design decision from earlier tonight, not an oversight. So the bar keeps its existing action
 * vocabulary unchanged: `Out` per line, `All out` per round over outstanding lines only. Flagged in
 * this rebuild's report rather than guessed further.
 *
 * ============================================================================================
 * A COLLECTED LINE STAYS ON SCREEN, STRUCK THROUGH, WITH AN UNDO — SEE useRecentlyCollected
 * ============================================================================================
 *
 * "A waiter who taps the wrong row has no way back... the tap must be recoverable." Wiring lives in
 * useDispatchBumpHandler below: it wraps the real onBump so a successful Collected tap records the
 * row's own data locally (before the next refetch drops it from board.readyRows entirely, same as
 * a voided line) and a successful Undo tap (the bar's existing `out` action — no new server action
 * needed) clears that local memory immediately.
 */

/** One shared bump instance for the whole Ready zone (see station-card.tsx's own note on why one
 *  instance per zone is enough — the same pattern the Active zone's per-round cards already use,
 *  just at zone scope instead of round scope since a dispatch row has no round to share one with).
 *
 *  Wraps the real onBump so the recoverable-collected ruling can be wired without re-implementing
 *  useCardBump's own pending/failed bookkeeping: a successful 'collected' tap records the row
 *  locally (markCollected) before it can vanish from the next refetch; a successful 'out' tap (the
 *  Undo button's own action) clears that local memory so the row falls back to being sourced from
 *  the server response, same as any other Ready row. */
function useDispatchBumpHandler(
  onBump: BumpLines,
  rows: DispatchRow[],
  markCollected: (row: DispatchRow) => void,
  clear: (lineId: string) => void,
): BumpLines {
  // Synced in an effect, not assigned during render -- a ref write during render is exactly what
  // React's own rules (and the compiler's static check) forbid, since render can run more than
  // once for the same commit. The callback below is only ever invoked from an event handler,
  // strictly after the render/effect that last updated `rows`, so this stays accurate for it.
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  return useCallback(
    async (lineIds, action) => {
      const outcome = await onBump(lineIds, action)
      if (action === 'collected') {
        const byId = new Map(rowsRef.current.map((row) => [row.lineId, row]))
        for (const lineId of lineIds) {
          if (outcome.failedLineIds.includes(lineId)) continue
          const row = byId.get(lineId)
          if (row) markCollected(row)
        }
      } else if (action === 'out') {
        for (const lineId of lineIds) {
          if (!outcome.failedLineIds.includes(lineId)) clear(lineId)
        }
      }
      return outcome
    },
    [onBump, markCollected, clear],
  )
}

/** One TO MAKE round — the only zone still card-shaped on this board. Unrouted rounds never reach
 *  here any more (see NotSentStrip below); every round this renders is routed and not-yet-ready. */
function BarActiveRoundCard({
  round,
  now,
  scale,
  onBump,
}: {
  round: BarRound
  now: number
  scale: DensityScale
  onBump: BumpLines
}) {
  const bump = useCardBump(onBump)
  const lineIds = round.items.map((item) => item.id)
  const escalation = barActiveLineEscalation(round, now)

  return (
    <StationCard
      testId="bar-round-card"
      tableLabel={orderIdentifier(round.tableNumber, round.orderNumber, 'bar')}
      contextLabel={orderContextLabel(round.orderType ?? null, round.servedBy ?? null)}
      ageLabel={formatMinutesShort(ageSeconds(round.placedAt ?? '', now) / 60)}
      escalation={escalation}
      scale={scale}
      headerAction={
        round.items.length > 1 ? (
          <PerCardButton
            label={STATION_COPY.bar.allReadyButton}
            count={round.items.length}
            lineIds={lineIds}
            action="out"
            tone="station"
            bump={bump}
            scale={scale}
          />
        ) : null
      }
      banner={<CardFailureBanner visibleLineIds={lineIds} bump={bump} scale={scale} />}
    >
      {round.items.map((item) => (
        <StationLineRow
          key={item.id}
          lineId={item.id}
          itemName={item.itemName}
          quantity={item.quantity}
          lineNote={item.lineNote}
          buttonLabel={STATION_COPY.bar.readyButton}
          action="out"
          tone="station"
          bump={bump}
          scale={scale}
          escalation={escalation}
        />
      ))}
    </StationCard>
  )
}

export function BarScreen({
  rounds,
  now,
  connectionState,
  onBump,
  venueName = null,
}: {
  rounds: BarRound[]
  now: number
  connectionState: FeedConnectionState
  onBump: BumpLines
  /** From the terminal session, never the URL. See StationVenueHeader. */
  venueName?: string | null
}) {
  const board = buildBarBoard(rounds, now)
  const activeScale = densityFor(board.active.length)

  const { entries: recentlyCollected, markCollected, clear } = useRecentlyCollected()
  const serverReadyIds = new Set(board.readyRows.map((row) => row.lineId))
  const stillRecoverable = Object.values(recentlyCollected)
    .map((entry) => entry.row)
    .filter((row) => !serverReadyIds.has(row.lineId))
  const collectedIds = new Set(stillRecoverable.map((row) => row.lineId))
  const displayRows = [...board.readyRows, ...stillRecoverable]
  const dispatchScale = dispatchDensityFor(displayRows.length)

  const dispatchOnBump = useDispatchBumpHandler(onBump, board.readyRows, markCollected, clear)
  const readyBump = useCardBump(dispatchOnBump)

  const unroutedItems = board.unrouted.flatMap((round) =>
    round.items.map((item) => ({
      lineId: item.id,
      tableNumber: round.tableNumber,
      quantity: item.quantity,
      itemName: item.itemName,
    })),
  )

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#F5F4F0] p-3"
      data-testid="bar-screen"
      data-density={activeScale.density}
      data-card-count={board.active.length + displayRows.length}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <StationVenueHeader station="bar" venueName={venueName} />
        <StationConnectionIndicator state={connectionState} />
      </div>

      {/*
        NOT SENT — full-width, above the scrollable two-surface area entirely, so it can never be
        buried by any amount of active or ready work. See station-card.tsx's NotSentStrip docblock.
      */}
      <NotSentStrip items={unroutedItems} tableLabel={(t, o) => orderIdentifier(t, o, 'bar')} />

      {/*
        THE ONE SCROLLABLE THING, AND IT IS SUPPOSED TO NEVER SCROLL — same contract the kitchen
        board holds itself to. 68% Active / 32% Ready by height, fixed regardless of either zone's
        own content: `flex-[68]`/`flex-[32]` on the two sections below, each independently
        overflow-auto so a genuine overflow shows as a scrollbar (an admission there is more)
        rather than being silently clipped.
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="station-board-body">
        <section
          /* See kitchen-screen.tsx's matching note: content-height, not viewport-height. */
          className="flex min-h-0 flex-[0_1_auto] flex-col overflow-y-auto overflow-x-hidden"
          data-testid="bar-active-section"
        >
          <h2 className="mb-1 text-lg font-black uppercase tracking-wide text-[#37352F]">
            {STATION_COPY.bar.activeHeading}
          </h2>
          {board.active.length === 0 ? (
            <div
              data-testid="active-zone-empty"
              className="flex h-full items-center justify-center py-10"
            >
              {/*
                AN IDLE BOARD MUST READ AS ALIVE AND EMPTY, NOT AS A PAGE THAT FAILED TO LOAD.
                This was a 16px grey line in the top-left corner of a 1920px wall display — from
                three metres that is indistinguishable from a blank screen, which is the reading a
                cook actually took from it. Centred in the zone it owns, at a size that resolves
                across a kitchen, and deliberately calm: nothing waiting is good news, so it must
                not borrow the visual weight of a fault.
              */}
              <p className="text-3xl font-medium text-[#A8A39A]">{STATION_COPY.bar.activeEmpty}</p>
            </div>
          ) : (
            <div className={`gap-1.5 ${activeScale.columnsClass}`} data-testid="bar-active-grid">
              {board.active.map((round) => (
                <BarActiveRoundCard key={round.id} round={round} now={now} scale={activeScale} onBump={onBump} />
              ))}
            </div>
          )}
        </section>

        {/*
          WAITING FOR COLLECTION — pinned to its own ~32% of the wall, dense dispatch rows, not
          cards. "No production cards... it is a dispatch queue, not a shrunken production card."
        */}
        <ReadySection
          heading={STATION_COPY.bar.readyHeading}
          emptyLabel={STATION_COPY.bar.readyEmpty}
          rowCount={displayRows.length}
          density={dispatchScale.density}
          testId="bar-ready-section"
        >
          {displayRows.map((row) => (
            <DispatchRowView
              key={row.lineId}
              row={row}
              now={now}
              escalation={barReadyRowEscalation(row, now)}
              scale={dispatchScale}
              tableLabel={(t, o) => orderIdentifier(t, o, 'bar')}
              action="collected"
              actionLabel={STATION_COPY.bar.collectedButton}
              tone="pass"
              bump={readyBump}
              collected={collectedIds.has(row.lineId)}
              undoLabel={STATION_COPY.dispatch.undoButton}
              onUndo={() => void readyBump.run([row.lineId], 'out')}
            />
          ))}
        </ReadySection>

        <OlderUnresolvedSection
          count={board.olderUnresolved.length}
          heading={STATION_COPY.older.heading}
          hint={STATION_COPY.older.hint}
        >
          {board.olderUnresolved.flatMap((round) =>
            round.items.map((item) => (
              <div
                key={item.id}
                data-testid="older-unresolved-row"
                data-line-id={item.id}
                className="flex items-center gap-2 px-2 py-0.5 text-sm text-[#8A857C]"
              >
                <span className="w-[7.5rem] shrink-0 truncate font-bold">
                  {STATION_COPY.bar.tableLabel(round.tableNumber)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {item.quantity}× {item.itemName}
                </span>
                <span className="shrink-0 tabular-nums opacity-70">{item.state}</span>
              </div>
            )),
          )}
        </OlderUnresolvedSection>
      </div>
    </div>
  )
}
