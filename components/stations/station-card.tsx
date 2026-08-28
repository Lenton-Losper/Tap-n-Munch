'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import type { AgeEscalation } from '@/lib/stations/age'
import type { DensityScale } from '@/lib/stations/board-density'
import type { BumpLines, StationBumpAction } from '@/lib/stations/bump'

/**
 * components/stations/station-card.tsx — the one card both boards are built out of.
 *
 * ============================================================================================
 * WHY BOTH SCREENS SHARE THIS FILE
 * ============================================================================================
 *
 * The bar screen was left behind when the kitchen was rebuilt for distance (02dd27c5): 14px item
 * text, a 1px border, three-across at any width. One person reads both boards during one service,
 * and two boards drawn to two different scales means the muscle memory built on one is wrong on the
 * other — where the table number is, how big a tappable thing is, what a border means.
 *
 * So the geometry lives here once. What differs between the two screens is what they PUT in it, not
 * how it is drawn.
 *
 * ============================================================================================
 * COLOUR IS THE AGE SIGNAL. THE NUMBER IS THE FOOTNOTE.
 * ============================================================================================
 *
 * At three metres a cook resolves a colour before they resolve a two-digit number, and on a
 * twenty-card wall they are choosing between cards, not reading them. So age is carried by the
 * border AND a body tint (a border alone is a few pixels at compact density and loses at an angle),
 * and the printed age stays as the second read once the card is chosen.
 *
 * `escalation: null` means NO escalation — the card is drawn neutral whatever its age. That is the
 * bar's standing ruling ("a warm beer is a smaller problem than a cold steak"), and it is expressed
 * as an explicit null rather than by the bar not passing a colour, so nobody later reads a missing
 * prop as an oversight and "fixes" it.
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

/** No age signal at all. Not a fourth colour — the absence of the colour language. */
const NEUTRAL_CLASSES = 'border-[#D8D6D0] bg-white text-[#37352F]'

export function escalationClasses(escalation: AgeEscalation | null): string {
  return escalation === null ? NEUTRAL_CLASSES : ESCALATION_CLASSES[escalation]
}

/**
 * One card's bump state, shared by its per-line buttons and its one per-table button.
 *
 * PENDING IS PER-LINE, NOT PER-CARD. Disabling a whole table because one dish is in flight would
 * stall a cook mid-service on a slow link; tracking the ids means only the button aimed at a line
 * already moving goes dead, which is the double-tap this guards against.
 */
export function useCardBump(onBump: BumpLines) {
  const [inFlight, setInFlight] = useState<string[]>([])
  const [failedLineIds, setFailedLineIds] = useState<string[]>([])
  const [lastAttempted, setLastAttempted] = useState<number>(0)

  const run = useCallback(
    async (lineIds: string[], action: StationBumpAction) => {
      if (lineIds.length === 0) return
      setInFlight((current) => [...current, ...lineIds])
      setLastAttempted(lineIds.length)
      try {
        const outcome = await onBump(lineIds, action)
        setFailedLineIds((current) => [
          // Anything in this tap that succeeded must clear its old marker, or a retry that works
          // would leave the card still accusing the line it just moved.
          ...current.filter((id) => !lineIds.includes(id)),
          ...outcome.failedLineIds,
        ])
      } finally {
        setInFlight((current) => current.filter((id) => !lineIds.includes(id)))
      }
    },
    [onBump],
  )

  const isPending = useCallback((lineIds: string[]) => lineIds.some((id) => inFlight.includes(id)), [inFlight])

  return { run, isPending, failedLineIds, lastAttempted }
}

export function BumpButton({
  label,
  lineIds,
  action,
  bump,
  tone,
  scale,
  full = false,
}: {
  label: string
  lineIds: string[]
  action: StationBumpAction
  bump: ReturnType<typeof useCardBump>
  tone: 'station' | 'pass'
  scale: DensityScale
  full?: boolean
}) {
  const pending = bump.isPending(lineIds)
  const toneClass =
    tone === 'station'
      ? 'bg-[#FF6B35] text-white hover:bg-[#e85f2f]'
      : 'bg-[#37352F] text-white hover:bg-[#25231f]'

  return (
    <button
      type="button"
      data-testid="station-bump-button"
      data-action={action}
      data-line-count={lineIds.length}
      disabled={pending}
      onClick={() => void bump.run(lineIds, action)}
      className={`shrink-0 rounded-xl font-bold disabled:opacity-60 ${toneClass} ${scale.buttonClass} ${
        full ? 'w-full' : ''
      }`}
    >
      {pending ? STATION_COPY.bumpFailure.working : label}
    </button>
  )
}

/**
 * The per-card shortcut: one control acting on every line the card is showing.
 *
 * The count is rendered as its own element beside the label because the label is still an unsigned
 * `PENDING COPY` marker (see lib/stations/copy.ts) and must stay a plain string literal in source
 * for scripts/check-no-pending-copy.mjs to see it. It is truncated to a button's worth of width so
 * an unsigned sentence cannot silently redesign the card while it waits for wording; a signed label
 * will be two or three words and will not clip.
 */
export function PerCardButton({
  label,
  count,
  lineIds,
  action,
  tone,
  bump,
  scale,
}: {
  label: string
  count: number
  lineIds: string[]
  action: StationBumpAction
  tone: 'station' | 'pass'
  bump: ReturnType<typeof useCardBump>
  scale: DensityScale
}) {
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="per-card-control" data-line-count={count}>
      <span className={`font-black tabular-nums opacity-60 ${scale.noteClass}`}>×{count}</span>
      <span className="block max-w-[7rem] truncate">
        <BumpButton label={label} lineIds={lineIds} action={action} bump={bump} tone={tone} scale={scale} full />
      </span>
    </span>
  )
}

/**
 * One row = one line = its own button. The default, and the reason the board is useful at all:
 * a salad and a steak do not finish together.
 */
export function StationLineRow({
  lineId,
  itemName,
  quantity,
  lineNote,
  buttonLabel,
  action,
  tone,
  bump,
  scale,
}: {
  lineId: string
  itemName: string
  quantity: number
  lineNote: string | null
  buttonLabel: string
  action: StationBumpAction
  tone: 'station' | 'pass'
  bump: ReturnType<typeof useCardBump>
  scale: DensityScale
}) {
  const failed = bump.failedLineIds.includes(lineId)
  return (
    <div
      data-testid="station-line-row"
      data-line-id={lineId}
      data-failed={failed ? 'true' : 'false'}
      className={`flex items-center justify-between gap-3 border-t border-current/15 first:border-t-0 ${scale.rowPadClass}`}
    >
      <div className="min-w-0">
        <p className={`font-bold leading-tight ${scale.itemClass}`}>
          {quantity}× {itemName}
        </p>
        {lineNote ? <p className={`mt-0.5 font-medium opacity-70 ${scale.noteClass}`}>{lineNote}</p> : null}
        {failed ? (
          <p data-testid="line-bump-failed" className={`mt-0.5 font-bold text-red-700 ${scale.noteClass}`}>
            {STATION_COPY.bumpFailure.lineMarker}
          </p>
        ) : null}
      </div>
      <BumpButton
        label={buttonLabel}
        lineIds={[lineId]}
        action={action}
        bump={bump}
        tone={tone}
        scale={scale}
      />
    </div>
  )
}

/**
 * WHAT THE CARD SAYS WHEN 3 OF 5 SUCCEEDED.
 *
 * It does not roll back, it does not retry on its own, and it does not disappear. The three that
 * moved leave the board on the next refetch, exactly as they would have if they had been tapped one
 * at a time; the two that did not stay, and are each marked ON THE ROW, with a count on the card
 * header saying how many of how many.
 *
 * The alternative — treat the batch as atomic and roll the three back — was rejected: it would mean
 * un-cooking food that IS cooked, writing three false audit events to undo three true ones, and
 * making a cook re-tap work they already did because of a line they never touched.
 *
 * The marker clears itself. It is rendered only for line ids the card is still showing, so once the
 * refused lines are resolved (retried, voided, bumped from another screen) it goes on its own
 * rather than needing a dismiss button nobody on a wall can press.
 */
export function CardFailureBanner({
  visibleLineIds,
  bump,
  scale,
}: {
  visibleLineIds: string[]
  bump: ReturnType<typeof useCardBump>
  scale: DensityScale
}) {
  const stillFailing = useMemo(
    () => bump.failedLineIds.filter((id) => visibleLineIds.includes(id)),
    [bump.failedLineIds, visibleLineIds],
  )
  if (stillFailing.length === 0) return null

  return (
    <div
      data-testid="card-bump-failure"
      data-failed-count={stillFailing.length}
      className={`mt-1.5 flex items-baseline gap-2 rounded-lg bg-red-600 px-2 py-1 font-bold text-white ${scale.noteClass}`}
    >
      {/* The counts are their own element, never interpolated into the copy — see copy.ts. */}
      <span className="tabular-nums" data-testid="card-bump-failure-count">
        {stillFailing.length}/{bump.lastAttempted}
      </span>
      <span>{STATION_COPY.bumpFailure.heading}</span>
    </div>
  )
}

export function StationCard({
  testId,
  tableLabel,
  ageLabel,
  escalation,
  scale,
  headerAction,
  banner,
  children,
}: {
  testId: string
  tableLabel: string
  ageLabel: string
  escalation: AgeEscalation | null
  scale: DensityScale
  headerAction?: ReactNode
  banner?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      data-escalation={escalation ?? 'none'}
      data-density={scale.density}
      // `break-inside-avoid` is load-bearing, not cosmetic: the board is a multi-column flow (see
      // lib/stations/board-density.ts) and without it a card would be split across two columns —
      // half a table's dishes at the bottom of one column and half at the top of the next.
      className={`mb-2 break-inside-avoid rounded-2xl ${scale.borderClass} ${
        scale.cardPadClass
      } ${escalationClasses(escalation)}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className={`font-black leading-none tabular-nums ${scale.tableClass}`}>{tableLabel}</p>
          <span className={`font-bold tabular-nums opacity-70 ${scale.noteClass}`} data-testid="card-age">
            {ageLabel}
          </span>
        </div>
        {headerAction}
      </div>
      {banner}
      <div className="mt-1.5">{children}</div>
    </div>
  )
}
