'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, formatAge, readyToRunEscalation, type AgeEscalation } from '@/lib/stations/age'
import { buildKitchenBoard } from '@/lib/stations/grouping'
import type { KitchenLine } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'

/**
 * Wall-mounted, read from ~3m with hands full. Every size decision here is driven by that, not
 * by ordinary screen density: table number is the single biggest thing on a card because that
 * is the one fact a cook needs to resolve before they've even walked over. Item + quantity is
 * the second-biggest thing. A modifier (line.lineNote — real data, per the four-state rebuild;
 * see lib/stations/types.ts) is smaller again, because it matters once you're already looking at
 * the right card, not before.
 */
const ESCALATION_CLASSES: Record<AgeEscalation, string> = {
  white: 'border-[#E9E9E7] bg-white text-[#37352F]',
  amber: 'border-amber-400 bg-amber-50 text-amber-900',
  red: 'border-red-500 bg-red-50 text-red-900',
  /**
   * Deliberately the QUIETEST card on the board, not the loudest.
   *
   * A line still sitting cooked hours later was orphaned, not missed. Painting it red puts it in
   * the same visual class as a plate going cold right now, and since abandoned cards accumulate
   * and live ones do not, red ends up mostly meaning "old" — which is what the owner saw. Muted
   * grey keeps it visible (somebody has to clear it) without spending the one colour that is
   * supposed to move a cook's hands.
   */
  stale: 'border-[#D8D6D0] bg-[#F2F1EE] text-[#8A857C]',
}

/**
 * A line the station has already cooked, waiting on the pass.
 *
 * THE CLOCK IS THE LINE'S COOKED TIME, NOT THE ORDER'S AGE. This previously keyed on the order's
 * placed_at because the GET carried no per-line transition timestamp; it now carries `cooked_at`
 * from order_line_events, so the card ages on how long the plate has actually been on the pass.
 * Under the old clock a steak that took eleven honest minutes opened red the instant it was tapped
 * Cooked, and the whole board went red within six minutes of a round landing.
 *
 * `placedAt` remains the fallback for a line whose cooked event could not be read — a degraded
 * colour is worth more than a blank card, and it is the pre-existing behaviour.
 */
function CookedCard({
  line,
  now,
  onMarkReadyToRun,
}: {
  line: KitchenLine
  now: number
  onMarkReadyToRun: (lineId: string) => void
}) {
  const minutes = ageMinutes(line.cookedAt ?? line.placedAt ?? '', now)
  const escalation = readyToRunEscalation(minutes)

  return (
    <div
      data-testid="cooked-card"
      data-escalation={escalation}
      className={`rounded-3xl border-8 px-8 py-6 ${ESCALATION_CLASSES[escalation]}`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-7xl font-black leading-none tabular-nums">{STATION_COPY.kitchen.tableLabel(line.tableNumber)}</p>
        <span className="rounded-full bg-black/10 px-4 py-1.5 text-2xl font-bold tabular-nums" data-testid="cooked-age">
          {formatAge(minutes)}
        </span>
      </div>
      <p className="mt-5 text-4xl font-extrabold leading-tight">
        {line.quantity}× {line.itemName}
      </p>
      {line.lineNote ? <p className="mt-1.5 text-2xl font-medium opacity-70">{line.lineNote}</p> : null}
      <button
        type="button"
        onClick={() => onMarkReadyToRun(line.id)}
        className="mt-5 w-full rounded-2xl bg-[#37352F] px-6 py-4 text-2xl font-bold text-white hover:bg-[#25231f]"
      >
        {STATION_COPY.kitchen.readyToRunButton}
      </button>
    </div>
  )
}

/** Outstanding: not yet cooked. The only action here is Cooked — Ready to run only ever applies
 *  to a line already in the cooked zone above, which is why this row takes no onMarkReadyToRun. */
function OutstandingLineRow({
  line,
  onMarkCooked,
}: {
  line: KitchenLine
  onMarkCooked: (lineId: string) => void
}) {
  return (
    <div
      data-testid="outstanding-line-row"
      className="flex items-center justify-between gap-4 border-t-2 border-[#EDECE8] py-4 first:border-t-0 first:pt-0"
    >
      <div className="min-w-0">
        <p className="text-4xl font-bold leading-tight text-[#37352F]">
          {line.quantity}× {line.itemName}
        </p>
        {line.lineNote ? <p className="mt-1 text-xl text-[#6B675F]">{line.lineNote}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onMarkCooked(line.id)}
        className="shrink-0 rounded-2xl bg-[#FF6B35] px-6 py-4 text-2xl font-bold text-white hover:bg-[#e85f2f]"
      >
        {STATION_COPY.kitchen.cookedButton}
      </button>
    </div>
  )
}

/** One card per table -- the whole point being that a cook scans cards, not lines. */
function OutstandingTableCard({
  tableNumber,
  lines,
  onMarkCooked,
}: {
  tableNumber: string
  lines: KitchenLine[]
  onMarkCooked: (lineId: string) => void
}) {
  return (
    <div
      data-testid="outstanding-table-card"
      className="rounded-3xl border-4 border-[#37352F] bg-white px-8 py-6"
    >
      <p className="text-center text-7xl font-black leading-none tabular-nums text-[#37352F]">
        {STATION_COPY.kitchen.tableLabel(tableNumber)}
      </p>
      <div className="mt-5">
        {lines.map((line) => (
          <OutstandingLineRow key={line.id} line={line} onMarkCooked={onMarkCooked} />
        ))}
      </div>
    </div>
  )
}

export function KitchenScreen({
  lines,
  now,
  connectionState,
  onMarkCooked,
  onMarkReadyToRun,
}: {
  lines: KitchenLine[]
  now: number
  connectionState: FeedConnectionState
  onMarkCooked: (lineId: string) => void
  onMarkReadyToRun: (lineId: string) => void
}) {
  const board = buildKitchenBoard(lines)

  return (
    <div className="min-h-screen bg-[#F5F4F0] p-6 sm:p-8" data-testid="kitchen-screen">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-3xl font-bold text-[#37352F]">{STATION_COPY.kitchen.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {board.unrouted.length > 0 ? (
        <div
          data-testid="unrouted-section"
          className="mb-8 rounded-3xl border-8 border-red-500 bg-red-50 p-6"
        >
          <h2 className="text-3xl font-black text-red-900">{STATION_COPY.unrouted.heading}</h2>
          <p className="mt-1 text-xl text-red-800">{STATION_COPY.unrouted.description}</p>
          <div className="mt-4 space-y-3">
            {board.unrouted.map((line) => (
              <div
                key={line.id}
                data-testid="unrouted-item"
                className="rounded-2xl border-2 border-red-300 bg-white px-5 py-4"
              >
                <p className="text-3xl font-bold text-red-900">
                  {STATION_COPY.kitchen.tableLabel(line.tableNumber)} — {line.quantity}× {line.itemName}
                </p>
                <p className="mt-1 text-xl font-semibold text-red-700">{STATION_COPY.unrouted.itemNote}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <section className="mb-10" data-testid="cooked-section">
        <h2 className="mb-4 text-4xl font-black uppercase tracking-wide text-[#37352F]">
          {STATION_COPY.kitchen.cookedHeading}
        </h2>
        {board.cooked.length === 0 ? (
          <p className="text-2xl text-[#6B675F]">{STATION_COPY.kitchen.cookedEmpty}</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {board.cooked.map((line) => (
              <CookedCard key={line.id} line={line} now={now} onMarkReadyToRun={onMarkReadyToRun} />
            ))}
          </div>
        )}
      </section>

      <section data-testid="outstanding-section">
        <h2 className="mb-4 text-3xl font-black uppercase tracking-wide text-[#37352F]">
          {STATION_COPY.kitchen.outstandingHeading}
        </h2>
        {board.outstandingByTable.length === 0 ? (
          <p className="text-2xl text-[#6B675F]">{STATION_COPY.kitchen.outstandingEmpty}</p>
        ) : (
          <div className="grid gap-5 xl:grid-cols-2">
            {board.outstandingByTable.map((table) => (
              <div key={table.tableNumber} data-testid="outstanding-table-group">
                <OutstandingTableCard tableNumber={table.tableNumber} lines={table.lines} onMarkCooked={onMarkCooked} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
