'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, readyToRunEscalation, type AgeEscalation } from '@/lib/stations/age'
import { buildKitchenBoard } from '@/lib/stations/grouping'
import type { KitchenLine } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'

const ESCALATION_CLASSES: Record<AgeEscalation, string> = {
  white: 'border-[#E9E9E7] bg-white text-[#37352F]',
  amber: 'border-amber-300 bg-amber-50 text-amber-900',
  red: 'border-red-300 bg-red-50 text-red-900',
}

function ageLabel(minutes: number): string {
  return minutes <= 0 ? STATION_COPY.age.justNow : STATION_COPY.age.minutes(minutes)
}

/**
 * A line the station has already cooked, waiting on the pass. Escalates in urgency the same way
 * the old "Ready to run" card did — see lib/stations/types.ts's docblock: the age driving that
 * escalation is the ORDER's age, not this line's own cooked timestamp, because the real GET
 * contract carries no per-line transition timestamp to key it on.
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
  const minutes = ageMinutes(line.placedAt ?? '', now)
  const escalation = readyToRunEscalation(minutes)

  return (
    <div
      data-testid="cooked-card"
      data-escalation={escalation}
      className={`flex items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 ${ESCALATION_CLASSES[escalation]}`}
    >
      <div>
        <p className="text-lg font-semibold">{STATION_COPY.kitchen.tableLabel(line.tableNumber)}</p>
        <p className="text-sm">
          {line.quantity}× {line.itemName}
        </p>
        {line.lineNote ? <p className="text-sm italic opacity-80">{line.lineNote}</p> : null}
      </div>
      <div className="flex flex-col items-end gap-2">
        <span className="text-sm font-medium tabular-nums" data-testid="cooked-age">
          {ageLabel(minutes)}
        </span>
        <button
          type="button"
          onClick={() => onMarkReadyToRun(line.id)}
          className="rounded-lg bg-[#37352F] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#25231f]"
        >
          {STATION_COPY.kitchen.readyToRunButton}
        </button>
      </div>
    </div>
  )
}

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
      className="flex items-center justify-between gap-3 rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2"
    >
      <span className="text-sm text-[#37352F]">
        {line.quantity}× {line.itemName}
        {line.lineNote ? <span className="ml-2 italic text-[#6B675F]">{line.lineNote}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onMarkCooked(line.id)}
        className="rounded-lg bg-[#FF6B35] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#e85f2f]"
      >
        {STATION_COPY.kitchen.cookedButton}
      </button>
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
    <div className="min-h-screen bg-[#FAFAF8] p-4 sm:p-6" data-testid="kitchen-screen">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-[#37352F]">{STATION_COPY.kitchen.pageTitle}</h1>
        <StationConnectionIndicator state={connectionState} />
      </div>

      {board.unrouted.length > 0 ? (
        <div
          data-testid="unrouted-section"
          className="mb-6 rounded-2xl border-2 border-red-400 bg-red-50 p-4"
        >
          <h2 className="text-lg font-bold text-red-900">{STATION_COPY.unrouted.heading}</h2>
          <p className="mt-1 text-sm text-red-800">{STATION_COPY.unrouted.description}</p>
          <div className="mt-3 space-y-2">
            {board.unrouted.map((line) => (
              <div
                key={line.id}
                data-testid="unrouted-item"
                className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-900"
              >
                <p>
                  {STATION_COPY.kitchen.tableLabel(line.tableNumber)} — {line.quantity}× {line.itemName}
                </p>
                <p className="mt-0.5 text-xs font-medium text-red-700">{STATION_COPY.unrouted.itemNote}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <section className="mb-8" data-testid="cooked-section">
        <h2 className="mb-3 text-xl font-bold uppercase tracking-wide text-[#37352F]">
          {STATION_COPY.kitchen.cookedHeading}
        </h2>
        {board.cooked.length === 0 ? (
          <p className="text-sm text-[#6B675F]">{STATION_COPY.kitchen.cookedEmpty}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {board.cooked.map((line) => (
              <CookedCard key={line.id} line={line} now={now} onMarkReadyToRun={onMarkReadyToRun} />
            ))}
          </div>
        )}
      </section>

      <section data-testid="outstanding-section">
        <h2 className="mb-3 text-lg font-semibold text-[#37352F]">{STATION_COPY.kitchen.outstandingHeading}</h2>
        {board.outstandingByTable.length === 0 ? (
          <p className="text-sm text-[#6B675F]">{STATION_COPY.kitchen.outstandingEmpty}</p>
        ) : (
          <div className="space-y-5">
            {board.outstandingByTable.map((table) => (
              <div key={table.tableNumber} data-testid="outstanding-table-group">
                <p className="mb-2 font-medium text-[#37352F]">{STATION_COPY.kitchen.tableLabel(table.tableNumber)}</p>
                <div className="space-y-1.5">
                  {table.lines.map((line) => (
                    <OutstandingLineRow key={line.id} line={line} onMarkCooked={onMarkCooked} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
