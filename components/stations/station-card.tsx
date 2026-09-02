'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import { ageSeconds, formatMinutesShort, type AgeEscalation } from '@/lib/stations/age'
import type { DensityScale, DispatchDensity } from '@/lib/stations/board-density'
import type { BumpLines, StationBumpAction } from '@/lib/stations/bump'
import type { DispatchRow } from '@/lib/stations/types'

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
  /** Only buttonClass is read — accepts DensityScale, DispatchDensity, or any shape carrying one,
   *  so a Ready dispatch row can share this same button without faking a whole card's scale. */
  scale: { buttonClass: string }
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
      <div className="min-w-0 flex-1">
        <p className={`font-bold leading-tight ${scale.itemClass}`}>
          {itemName}
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
      {/*
        QUANTITY AS ITS OWN RIGHT-ALIGNED COLUMN, not "2x Spring Rolls" inside the name.
        A cook counting covers scans a straight right-hand edge; embedded in a sentence, the number
        moves horizontally with the length of every dish name above it and has to be hunted for on
        each line. Same size and weight as the item name, because on a ticket the count is not
        secondary to the dish -- getting it wrong is the error that reaches a table.
      */}
      <span
        data-testid="line-quantity"
        className={`shrink-0 pl-2 text-right font-black leading-tight tabular-nums ${scale.itemClass}`}
      >
        {quantity}
      </span>
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
  contextLabel = null,
  children,
}: {
  testId: string
  tableLabel: string
  ageLabel: string
  escalation: AgeEscalation | null
  scale: DensityScale
  headerAction?: ReactNode
  banner?: ReactNode
  /**
   * "Eat-in - by Paulus". Absent renders nothing at all: a card that says neither is the normal
   * case for a QR order at a table, and inventing a value to fill the row would be worse than an
   * empty one. See STATION_COPY.orderType.
   */
  contextLabel?: string | null
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
      {/*
        AGE IS THE PROMINENT READ, TOP-RIGHT. Reversed 20260829: the per-round shortcut used to sit
        where a busy reader's eye lands first, with age demoted to small and muted next to the
        table number. Owner, walking a twelve-round board: "I read time before I read a count." A
        shortcut is not a fact about the round the way its age is -- it does not need the loudest
        corner, and most rounds do not even have one (see PerCardButton's own single-line gate).
      */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className={`font-black leading-none tabular-nums ${scale.tableClass}`}>{tableLabel}</p>
          {headerAction}
        </div>
        {/*
          SECONDARY, 2026-09-01. This rendered at `tableClass` — the SAME size as the table
          number, 36px at roomy — so a ticking clock competed head-on with the one token that
          routes a plate to a human, and motion wins that contest every time. It is now the
          quietest element on the card: small, medium weight, muted. Urgency is the card's border
          and tint (escalationClasses), which resolves at three metres where two digits do not.
        */}
        <span
          className={`shrink-0 font-medium leading-none tabular-nums opacity-60 ${scale.noteClass}`}
          data-testid="card-age"
        >
          {ageLabel}
        </span>
      </div>
      {/*
        WHERE THE ORDER GOES AND WHO SENT IT. Third in the reading order deliberately -- table
        number, then age, then this. It is the line that answers "is this going to a table or to
        the counter", which a cook needs once per ticket rather than continuously, so it is quiet
        and small. It never wraps to a second line at any density: at roomy it is one short phrase.
      */}
      {contextLabel ? (
        <p
          className={`mt-0.5 truncate font-medium uppercase tracking-wide opacity-70 ${scale.noteClass}`}
          data-testid="card-context"
        >
          {contextLabel}
        </p>
      ) : null}
      {banner}
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

/**
 * ============================================================================================
 * NOT SENT — A FULL-WIDTH FAULT STRIP AT THE TOP OF THE WHOLE BOARD, SHARED BY BOTH SCREENS
 * ============================================================================================
 *
 * Second-pass redesign: "NOT SENT becomes a full-width high-contrast fault strip at the TOP OF
 * THE WHOLE BOARD, not a card among cards. It can never be buried by normal work." The first pass
 * drew it as a red-bordered BOX sitting first in the scrollable content — still, structurally, a
 * card among cards, just a loud one. This is full-bleed (no side margin, no rounded corners, no
 * card padding) and it is a caller's job to render it OUTSIDE the scrollable two-surface area
 * entirely (see kitchen-screen.tsx / bar-screen.tsx), not merely first inside it — "can never be
 * buried" means it cannot be pushed off by ANY amount of active or ready work, not just usually.
 *
 * Every unrouted item is still named on the strip itself, not just counted — "This item has no
 * station set" is exactly the sentence that stops food going unseen, per the original ruling this
 * carries forward unchanged.
 */
export function NotSentStrip({
  items,
  tableLabel,
}: {
  items: Array<{ lineId: string; tableNumber: string; quantity: number; itemName: string }>
  tableLabel: (tableNumber: string, orderNumber?: string | number | null) => string
}) {
  if (items.length === 0) return null
  return (
    <div
      data-testid="unrouted-section"
      className="shrink-0 bg-red-600 px-3 py-1.5 text-white"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-lg font-black uppercase tracking-wide">{STATION_COPY.unrouted.heading}</span>
        <span className="text-sm font-semibold text-red-100">{STATION_COPY.unrouted.description}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
        {items.map((item) => (
          <span key={item.lineId} data-testid="unrouted-item" className="font-bold">
            {tableLabel(item.tableNumber)} — {item.quantity}× {item.itemName}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * ============================================================================================
 * THE DISPATCH ROW — READY'S OWN PRIMITIVE, NOT A SHRUNKEN STATIONCARD
 * ============================================================================================
 *
 * "No production cards. Dense rows: 'T12 · Ribeye MR · READY 02:11 · [Collected]'... it is a
 * dispatch queue, not a shrunken production card." One row = one line, table carried inline as a
 * column rather than a heading. Shared by both boards ("same language, same dimensions") so
 * neither screen invents its own Ready row shape.
 *
 * Urgency is a left border accent + a body tint, same colour language as StationCard, at a much
 * smaller footprint — a whole card's border/background treatment on a one-line row would be
 * louder than the row itself.
 */
const DISPATCH_ACCENT_CLASSES: Record<AgeEscalation, string> = {
  white: 'border-[#E9E9E7] bg-white text-[#37352F]',
  amber: 'border-amber-400 bg-amber-50 text-amber-900',
  red: 'border-red-500 bg-red-50 text-red-900',
  stale: 'border-[#D8D6D0] bg-[#F2F1EE] text-[#8A857C]',
}

export function DispatchRowView({
  row,
  now,
  escalation,
  scale,
  tableLabel,
  action,
  actionLabel,
  tone,
  bump,
  collected,
  undoLabel,
  onUndo,
}: {
  row: DispatchRow
  now: number
  escalation: AgeEscalation
  scale: DispatchDensity
  tableLabel: (tableNumber: string, orderNumber?: string | number | null) => string
  /** "READY" / "WAITING" — the word between the item and the clock. Signed per board. */
  action: StationBumpAction
  actionLabel: string
  tone: 'station' | 'pass'
  bump: ReturnType<typeof useCardBump>
  /** True while this row is in its short recoverable window after being tapped — struck through,
   *  showing Undo instead of the collect action. See useRecentlyCollected. */
  collected?: boolean
  undoLabel?: string
  onUndo?: () => void
}) {
  const elapsed = ageSeconds(row.readyAt ?? row.placedAt ?? '', now)
  const failed = bump.failedLineIds.includes(row.lineId)

  return (
    <div
      data-testid="dispatch-row"
      data-line-id={row.lineId}
      data-escalation={escalation}
      data-collected={collected ? 'true' : 'false'}
      className={`flex items-center gap-2 border-l-4 ${scale.rowPadClass} px-2 ${DISPATCH_ACCENT_CLASSES[escalation]} ${collected ? 'opacity-70' : ''}`}
    >
      {/* TABLE | ITEM | TIME | ACTION — four fixed slots, so the eye lands in the same place on
          every row. The table is its own column rather than run into the item name: it is the
          token that routes a plate to a human, and at a glance it must not need parsing. */}
      <span className={`w-[7.5rem] shrink-0 truncate font-black ${scale.rowTextClass}`}>
        {tableLabel(row.tableNumber, row.orderNumber)}
      </span>
      <span className={`min-w-0 flex-1 truncate font-bold ${scale.rowTextClass} ${collected ? 'line-through' : ''}`}>
        {row.quantity}× {row.itemName}
        {row.lineNote ? <span className="ml-1.5 font-black text-red-900">⚠ {row.lineNote}</span> : null}
      </span>
      {/* Whole minutes, no seconds — see formatMinutesShort. Deliberately the quietest element in
          the row: normal weight, muted, small. Urgency is the border accent, not this number. */}
      <span className={`w-14 shrink-0 text-right font-medium tabular-nums opacity-60 ${scale.clockClass}`} data-testid="dispatch-row-clock">
        {formatMinutesShort(elapsed / 60)}
      </span>
      {collected ? (
        <button
          type="button"
          data-testid="dispatch-row-undo"
          onClick={onUndo}
          className={`shrink-0 rounded-lg bg-[#37352F] font-bold text-white ${scale.buttonClass}`}
        >
          {undoLabel}
        </button>
      ) : (
        <BumpButton
          label={actionLabel}
          lineIds={[row.lineId]}
          action={action}
          bump={bump}
          tone={tone}
          scale={scale}
        />
      )}
      {failed ? (
        <span data-testid="line-bump-failed" className={`shrink-0 font-bold text-red-700 ${scale.clockClass}`}>
          {STATION_COPY.bumpFailure.lineMarker}
        </span>
      ) : null}
    </div>
  )
}

/**
 * ============================================================================================
 * "A COLLECTED LINE SHOULD NOT VANISH THE INSTANT IT IS TAPPED" — THE ONE RULING CHANGED FROM
 * THE PROPOSAL, AND EASY TO MISS
 * ============================================================================================
 *
 * "A waiter who taps the wrong row has no way back and no record on screen that it happened.
 * Keep it visible, struck through, for a short window - or give the row an undo. Your call which,
 * but the tap must be recoverable. That is the same acknowledge-not-expire principle from the
 * void design." Built as BOTH at once, not a choice between them: the row stays visible, struck
 * through, WITH an Undo button, for one short window — recoverable by construction rather than by
 * a race between "did I notice in time" and "did it already vanish".
 *
 * A collected line leaves GET /api/station/lines' response entirely (excluded server-side, same
 * as voided), so this is CLIENT-ONLY memory of "I just told the server to collect this" — the row
 * would otherwise disappear on the very next refetch with nothing left on screen to undo. Undo
 * re-bumps to 'ready' (the kitchen's ready_to_run / the bar's out action both already map there
 * server-side — no new server action needed) and clears the local memory immediately; the row
 * then reappears from the next real refetch, the same as any other ready row.
 *
 * PRUNED ON A TIMER, NOT ON REFETCH: the row must stay struck-through for the FULL window even if
 * a refetch happens to land in the middle of it (a busy board refetches often), or "keep it
 * visible" would only be true between refetches, not for the promised duration.
 */
const RECOVERABLE_WINDOW_MS = 8000

export function useRecentlyCollected() {
  const [entries, setEntries] = useState<Record<string, { row: DispatchRow; collectedAtMs: number }>>({})

  useEffect(() => {
    const id = window.setInterval(() => {
      setEntries((current) => {
        const now = Date.now()
        const next: typeof current = {}
        let changed = false
        for (const [lineId, entry] of Object.entries(current)) {
          if (now - entry.collectedAtMs < RECOVERABLE_WINDOW_MS) {
            next[lineId] = entry
          } else {
            changed = true
          }
        }
        return changed ? next : current
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const markCollected = useCallback((row: DispatchRow) => {
    setEntries((current) => ({ ...current, [row.lineId]: { row, collectedAtMs: Date.now() } }))
  }, [])

  const clear = useCallback((lineId: string) => {
    setEntries((current) => {
      if (!(lineId in current)) return current
      const next = { ...current }
      delete next[lineId]
      return next
    })
  }, [])

  return { entries, markCollected, clear }
}

/* ============================================================================================
 * SHARED SECTIONS — both boards render these, neither owns them.
 * ==========================================================================================*/

/**
 * THE READY ZONE. Elastic, capped, and honest when empty.
 *
 * WHY IT COLLAPSES. The old layout gave Ready a fixed `flex-[32]` of the wall whether or not it
 * held anything, so a quiet board spent a third of a 1080p screen rendering the words "Nothing
 * ready." while the live orders above it were squeezed into a smaller tier. Now it takes only the
 * height its rows need, up to a maximum, and shrinks to a single summary line when there is
 * nothing to dispatch — Active gets the space back automatically, with no branch anywhere else.
 *
 * WHY A MAXIMUM. Ready must never be allowed to push Active off the screen either. Past the cap
 * it scrolls VERTICALLY inside itself. It is `overflow-y-auto` with `overflow-x-hidden`: the rows
 * are a flex column, so there is no mechanism by which content can travel sideways, and the
 * explicit x-hidden is belt-and-braces against a future row that forgets to truncate.
 */
export function ReadySection({
  heading,
  emptyLabel,
  rowCount,
  density,
  testId,
  children,
}: {
  heading: string
  emptyLabel: string
  rowCount: number
  density: string
  testId: string
  children: ReactNode
}) {
  const empty = rowCount === 0
  return (
    <section
      data-testid={testId}
      data-ready-density={density}
      data-ready-collapsed={empty ? 'true' : 'false'}
      data-ready-count={rowCount}
      className={`mt-2 flex shrink-0 flex-col border-t-4 border-[#37352F] pt-1.5 ${
        empty ? '' : 'max-h-[38vh] min-h-0'
      }`}
    >
      <h2 className="mb-1 flex shrink-0 items-baseline gap-2 text-lg font-black uppercase tracking-wide text-[#37352F]">
        <span>{heading}</span>
        <span className="tabular-nums opacity-60">· {rowCount}</span>
      </h2>
      {empty ? (
        /*
         * NOTHING. Not a sentence, not a placeholder — the heading already reads "READY · 0",
         * which is the whole message. An empty Ready zone is now one heading row tall, and every
         * pixel below it belongs to Active. `emptyLabel` is still accepted and still the single
         * source of that wording for any caller that wants it; this surface simply does not need
         * a second way of saying zero.
         */
        null
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-testid="ready-dispatch-list"
        >
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * OLDER UNRESOLVED — the 12h partition, collapsed by default, never hidden.
 *
 * These lines are still live work in the database; nothing about them has been collected, voided
 * or written. They are simply not what anyone on this shift is about to make, and leaving them in
 * the main grid did active harm: on production 2026-09-01 twelve 3-to-4-day-old lines were 80% of
 * the kitchen board AND pushed the density tier down far enough to shrink the three real orders.
 *
 * Collapsed, not removed. A summary row states how many there are and opens on tap. The count is
 * always visible even when closed, because a board that silently forgets work is worse than a
 * cluttered one — that is the whole reason this is a partition and not a filter.
 */
export function OlderUnresolvedSection({
  count,
  heading,
  hint,
  children,
}: {
  count: number
  heading: string
  hint: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (count === 0) return null
  return (
    <section
      data-testid="older-unresolved-section"
      data-older-count={count}
      data-older-open={open ? 'true' : 'false'}
      className="mt-2 shrink-0 border-t-2 border-dashed border-[#B8B4AC]"
    >
      <button
        type="button"
        data-testid="older-unresolved-toggle"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 py-1 text-left text-sm font-black uppercase tracking-wide text-[#8A857C]"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{heading}</span>
        <span className="tabular-nums">· {count}</span>
        <span className="ml-2 font-medium normal-case tracking-normal opacity-70">{hint}</span>
      </button>
      {open ? (
        <div className="max-h-[30vh] overflow-y-auto overflow-x-hidden pb-1" data-testid="older-unresolved-list">
          {children}
        </div>
      ) : null}
    </section>
  )
}
