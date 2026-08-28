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

function ReadyToRunCard({ line, now }: { line: KitchenLine; now: number }) {
  const minutes = ageMinutes(line.readyToRunAt as string, now)
  const escalation = readyToRunEscalation(minutes)

  return (
    <div
      data-testid="ready-to-run-card"
      data-escalation={escalation}
      className={`flex items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 ${ESCALATION_CLASSES[escalation]}`}
    >
      <div>
        <p className="text-lg font-semibold">{STATION_COPY.kitchen.tableLabel(line.tableNumber)}</p>
        <p className="text-sm">
          {line.quantity}× {line.itemName}
        </p>
      </div>
      <span className="text-sm font-medium tabular-nums" data-testid="ready-to-run-age">
        {ageLabel(minutes)}
      </span>
    </div>
  )
}

function OutstandingLineRow({
  line,
  onMarkCooked,
  onMarkReadyToRun,
}: {
  line: KitchenLine
  onMarkCooked: (lineId: string) => void
  onMarkReadyToRun: (lineId: string) => void
}) {
  const status = line.cookedAt ? 'cooked' : 'outstanding'

  return (
    <div
      data-testid="outstanding-line-row"
      data-status={status}
      className="flex items-center justify-between gap-3 rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2"
    >
      <span className="text-sm text-[#37352F]">
        {line.quantity}× {line.itemName}
      </span>
      {status === 'outstanding' ? (
        <button
          type="button"
          onClick={() => onMarkCooked(line.id)}
          className="rounded-lg bg-[#FF6B35] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#e85f2f]"
        >
          {STATION_COPY.kitchen.cookedButton}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onMarkReadyToRun(line.id)}
          className="rounded-lg bg-[#37352F] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#25231f]"
        >
          {STATION_COPY.kitchen.readyToRunButton}
        </button>
      )}
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

      <section className="mb-8" data-testid="ready-to-run-section">
        <h2 className="mb-3 text-xl font-bold uppercase tracking-wide text-[#37352F]">
          {STATION_COPY.kitchen.readyToRunHeading}
        </h2>
        {board.readyToRun.length === 0 ? (
          <p className="text-sm text-[#6B675F]">{STATION_COPY.kitchen.readyToRunEmpty}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {board.readyToRun.map((line) => (
              <ReadyToRunCard key={line.id} line={line} now={now} />
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
                <div className="space-y-3">
                  {table.stationGroups.map((group) => (
                    <div key={group.station} data-testid="outstanding-station-group" data-station={group.station}>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[#6B675F]">
                        {group.station}
                      </p>
                      <div className="space-y-1.5">
                        {group.lines.map((line) => (
                          <OutstandingLineRow
                            key={line.id}
                            line={line}
                            onMarkCooked={onMarkCooked}
                            onMarkReadyToRun={onMarkReadyToRun}
                          />
                        ))}
                      </div>
                    </div>
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
