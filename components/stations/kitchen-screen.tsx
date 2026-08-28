'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { ageMinutes, readyToRunEscalation, type AgeEscalation } from '@/lib/stations/age'
import { buildKitchenBoard } from '@/lib/stations/grouping'
import type { KitchenLine } from '@/lib/stations/types'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'
import { StationConnectionIndicator } from '@/components/stations/station-connection-indicator'

/**
 * Wall-mounted, read from ~3m with hands full. Every size decision here is driven by that, not
 * by ordinary screen density: table number is the single biggest thing on a card because that
 * is the one fact a cook needs to resolve before they've even walked over. Item + quantity is
 * the second-biggest thing. A modifier (parsed off the item name after the first comma -- "Ribeye,
 * medium" -> "Ribeye" + "medium") is smaller again, because it matters once you're already
 * looking at the right card, not before.
 */
const ESCALATION_CLASSES: Record<AgeEscalation, string> = {
  white: 'border-[#E9E9E7] bg-white text-[#37352F]',
  amber: 'border-amber-400 bg-amber-50 text-amber-900',
  red: 'border-red-500 bg-red-50 text-red-900',
}

function ageLabel(minutes: number): string {
  return minutes <= 0 ? STATION_COPY.age.justNow : STATION_COPY.age.minutes(minutes)
}

function splitModifier(itemName: string): { name: string; modifier: string | null } {
  const commaIndex = itemName.indexOf(',')
  if (commaIndex === -1) return { name: itemName, modifier: null }
  return { name: itemName.slice(0, commaIndex).trim(), modifier: itemName.slice(commaIndex + 1).trim() }
}

function ReadyToRunCard({ line, now }: { line: KitchenLine; now: number }) {
  const minutes = ageMinutes(line.readyToRunAt as string, now)
  const escalation = readyToRunEscalation(minutes)
  const { name, modifier } = splitModifier(line.itemName)

  return (
    <div
      data-testid="ready-to-run-card"
      data-escalation={escalation}
      className={`rounded-3xl border-8 px-8 py-6 ${ESCALATION_CLASSES[escalation]}`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-7xl font-black leading-none tabular-nums">{STATION_COPY.kitchen.tableLabel(line.tableNumber)}</p>
        <span className="rounded-full bg-black/10 px-4 py-1.5 text-2xl font-bold tabular-nums" data-testid="ready-to-run-age">
          {ageLabel(minutes)}
        </span>
      </div>
      <p className="mt-5 text-4xl font-extrabold leading-tight">
        {line.quantity}× {name}
      </p>
      {modifier ? <p className="mt-1.5 text-2xl font-medium opacity-70">{modifier}</p> : null}
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
  const { name, modifier } = splitModifier(line.itemName)

  return (
    <div
      data-testid="outstanding-line-row"
      data-status={status}
      className="flex items-center justify-between gap-4 border-t-2 border-[#EDECE8] py-4 first:border-t-0 first:pt-0"
    >
      <div className="min-w-0">
        <p className="text-4xl font-bold leading-tight text-[#37352F]">
          {line.quantity}× {name}
        </p>
        {modifier ? <p className="mt-1 text-xl text-[#6B675F]">{modifier}</p> : null}
      </div>
      {status === 'outstanding' ? (
        <button
          type="button"
          onClick={() => onMarkCooked(line.id)}
          className="shrink-0 rounded-2xl bg-[#FF6B35] px-6 py-4 text-2xl font-bold text-white hover:bg-[#e85f2f]"
        >
          {STATION_COPY.kitchen.cookedButton}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onMarkReadyToRun(line.id)}
          className="shrink-0 rounded-2xl bg-[#37352F] px-6 py-4 text-2xl font-bold text-white hover:bg-[#25231f]"
        >
          {STATION_COPY.kitchen.readyToRunButton}
        </button>
      )}
    </div>
  )
}

/** One card per table -- the whole point being that a cook scans cards, not lines. */
function OutstandingTableCard({
  tableNumber,
  lines,
  onMarkCooked,
  onMarkReadyToRun,
}: {
  tableNumber: string
  lines: KitchenLine[]
  onMarkCooked: (lineId: string) => void
  onMarkReadyToRun: (lineId: string) => void
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
          <OutstandingLineRow key={line.id} line={line} onMarkCooked={onMarkCooked} onMarkReadyToRun={onMarkReadyToRun} />
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

      <section className="mb-10" data-testid="ready-to-run-section">
        <h2 className="mb-4 text-4xl font-black uppercase tracking-wide text-[#37352F]">
          {STATION_COPY.kitchen.readyToRunHeading}
        </h2>
        {board.readyToRun.length === 0 ? (
          <p className="text-2xl text-[#6B675F]">{STATION_COPY.kitchen.readyToRunEmpty}</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {board.readyToRun.map((line) => (
              <ReadyToRunCard key={line.id} line={line} now={now} />
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
                <OutstandingTableCard
                  tableNumber={table.tableNumber}
                  lines={table.stationGroups.flatMap((group) => group.lines)}
                  onMarkCooked={onMarkCooked}
                  onMarkReadyToRun={onMarkReadyToRun}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
