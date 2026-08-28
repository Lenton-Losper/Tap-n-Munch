'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import type { AgeEscalation } from '@/lib/stations/age'
import type { DensityScale } from '@/lib/stations/board-density'
import type { BumpLines, StationBumpAction } from '@/lib/stations/bump'

/**
 * components/stations/station-card.tsx — the one round both boards are built out of.
 *
 * ============================================================================================
 * REBUILT 20260829160000 — A ROUND IS A FEW LINES, NOT A CARD
 * ============================================================================================
 *
 * "At real dinner volume the current boards do not work. One round takes 300-500px, so twenty
 * tables means a scrolling wall screen, and a wall screen nobody touches cannot be scrolled."
 * StationCard used to spend most of that height on box — `rounded-2xl`, `border-8`, `px-5 py-4`
 * — around a handful of lines. This keeps the same primitive (one round, its table/age header,
 * its lines, its per-line and per-round controls) with the chrome cut to what a colour needs to
 * read, not what a card needs to look designed. See lib/stations/board-density.ts's own note on
 * why the text floors did not move even though the box did.
 *
 * ============================================================================================
 * COLOUR IS THE AGE SIGNAL. THE NUMBER IS THE FOOTNOTE.
 * ============================================================================================
 *
 * Unchanged from the first rebuild: a border AND a body tint (a border alone is a few pixels at
 * compact density and loses at an angle), the printed age as the second read. `escalation: null`
 * means NO escalation — drawn neutral whatever its age — passed explicitly rather than omitted so
 * nobody later reads a missing prop as an oversight.
 */
const ESCALATION_CLASSES: Record<AgeEscalation, string> = {
  white: 'border-[#E9E9E7] bg-white text-[#37352F]',
  amber: 'border-amber-400 bg-amber-50 text-amber-900',
  red: 'border-red-500 bg-red-50 text-red-900',
  /**
   * Deliberately the QUIETEST round on the board, not the loudest — an abandoned line, not a
   * missed one. See lib/stations/age.ts's own note on STALE_MINUTES.
   */
  stale: 'border-[#D8D6D0] bg-[#F2F1EE] text-[#8A857C]',
}

/** No age signal at all. Not a fourth colour — the absence of the colour language. */
const NEUTRAL_CLASSES = 'border-[#D8D6D0] bg-white text-[#37352F]'

export function escalationClasses(escalation: AgeEscalation | null): string {
  return escalation === null ? NEUTRAL_CLASSES : ESCALATION_CLASSES[escalation]
}

/**
 * One round's bump state, shared by its per-line buttons and its one per-round button.
 *
 * PENDING IS PER-LINE, NOT PER-ROUND. Disabling a whole table because one dish is in flight would
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
      className={`shrink-0 rounded-lg font-bold disabled:opacity-60 ${toneClass} ${scale.buttonClass} ${
        full ? 'w-full' : ''
      }`}
    >
      {pending ? STATION_COPY.bumpFailure.working : label}
    </button>
  )
}

/**
 * The per-round shortcut: one control acting on every line the round is showing in this zone.
 *
 * The count is rendered as its own element beside the label because the label is still an unsigned
 * `PENDING COPY` marker (see lib/stations/copy.ts) and must stay a plain string literal in source
 * for scripts/check-no-pending-copy.mjs to see it. It is truncated to a button's worth of width so
 * an unsigned sentence cannot silently redesign the round while it waits for wording; a signed label
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
      {/* 9rem, not 7rem: "All collected" (this rebuild's longest signed label) clipped mid-word at
          7rem — found by actually looking at the rendered board, not by counting characters. */}
      <span className="block max-w-[9rem] truncate">
        <BumpButton label={label} lineIds={lineIds} action={action} bump={bump} tone={tone} scale={scale} full />
      </span>
    </span>
  )
}

/**
 * One row = one line = its own button. The default, and the reason the board is useful at all:
 * a salad and a steak do not finish together.
 *
 * ============================================================================================
 * THE NOTE IS AN ALLERGY/SPECIAL-INSTRUCTION CARRIER, NOT A STYLING FOOTNOTE
 * ============================================================================================
 *
 * order_lines.line_note is the only field this schema has for "no nuts", "anaphylaxis", "deathly
 * allergic to shellfish" — there is no dedicated allergy column anywhere (checked directly against
 * the schema). It used to render at `opacity-70`, the same visual weight as an ordinary cooking
 * instruction ("medium rare"). That is wrong for a note that might be the one line standing
 * between a plate and a hospital visit, so it now renders as its own loud, bordered marker rather
 * than muted text under the item name — every note, because this board has no way to tell an
 * allergy note from any other kind and a missed allergy is a worse failure than an over-loud
 * cooking instruction.
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
  escalation = null,
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
  /**
   * The individual PLATE/DRINK's own urgency — data only, not a second visual tint. The round's
   * one colour already comes from StationCard's `escalation` (the worst among its lines); this is
   * carried here so a caller reading the DOM (a test, a future runner view) can tell two lines
   * inside the same round apart, the way the first density rebuild's `cooked-card` testid did.
   */
  escalation?: AgeEscalation | null
}) {
  const failed = bump.failedLineIds.includes(lineId)
  return (
    <div
      data-testid="station-line-row"
      data-line-id={lineId}
      data-failed={failed ? 'true' : 'false'}
      data-escalation={escalation ?? 'none'}
      className={`flex items-center justify-between gap-3 border-t border-current/15 first:border-t-0 ${scale.rowPadClass}`}
    >
      <div className="min-w-0">
        <p className={`font-bold leading-tight ${scale.itemClass}`}>
          {quantity}× {itemName}
        </p>
        {lineNote ? (
          <p
            data-testid="line-note"
            className={`mt-0.5 inline-block rounded bg-red-100 px-1 font-bold text-red-900 ${scale.noteClass}`}
          >
            ⚠ {lineNote}
          </p>
        ) : null}
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
 * WHAT THE ROUND SAYS WHEN 3 OF 5 SUCCEEDED.
 *
 * It does not roll back, it does not retry on its own, and it does not disappear. The three that
 * moved leave the board on the next refetch, exactly as they would have if they had been tapped one
 * at a time; the two that did not stay, and are each marked ON THE ROW, with a count on the round's
 * header saying how many of how many.
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
      className={`mt-1 flex items-baseline gap-2 rounded bg-red-600 px-1.5 py-0.5 font-bold text-white ${scale.noteClass}`}
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
      // lib/stations/board-density.ts) and without it a round would be split across two columns —
      // half a table's dishes at the bottom of one column and half at the top of the next.
      className={`mb-1 break-inside-avoid rounded-lg ${scale.borderClass} ${
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
      <div className="mt-0.5">{children}</div>
    </div>
  )
}
