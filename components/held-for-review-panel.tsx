'use client'

/**
 * #353 — the "Held for review" surface on the staff dashboard.
 *
 * NOT `@ts-nocheck`, and that is deliberate. `components/orders-dashboard.tsx` still carries the
 * pragma on this branch, which means tsc skips it entirely — the 2026-08-26 production outage
 * (`ReferenceError: STRANDED_CLAIM_COPY is not defined`, live across three deploys) happened
 * inside it for exactly that reason. A money surface whose whole job is to be correct when nobody
 * is looking does not go in an unchecked file. The dashboard passes it props; everything that can
 * be wrong is wrong here, where tsc reads it.
 *
 * PURELY PRESENTATIONAL. It decides nothing, writes nothing and queries nothing — see
 * lib/orders/held-for-review.ts for the classification and lib/supabase/orders.ts for the read.
 *
 * THE THREE STATES ARE DISTINCT, AND THAT IS THE WHOLE DESIGN:
 *
 *   loading  ->  says so
 *   failed   ->  says so, LOUDLY, and never renders as empty
 *   empty    ->  renders nothing at all
 *
 * A failed load that renders like an empty one is the defect this surface exists to remove, one
 * level up: "all clear" gets shipped, "it's present" gets verified. So the error state is the
 * only one of the three that is impossible to confuse with success.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  HELD_FOR_REVIEW_SECTION_COPY,
  formatHeldDuration,
  heldAmountDigits,
  type HeldForReviewRow,
} from '@/lib/orders/held-for-review'
import { hasAllocatedOrderNumber } from '@/lib/orders/order-identity'
import { OVERRIDE_CANCEL_COPY } from '@/lib/orders/override-cancel-copy'
/**
 * FROM THE OUTCOMES MODULE, NOT THE ACTION. Importing the action here pulls the Finatic credentials
 * chain — restaurant cache, lib/redis, @upstash/redis — into the browser bundle. That is what the
 * split exists to prevent, and it is not something tsc or a passing render test would ever notice.
 */
import {
  clearHeldBanner,
  type ClearHeldSummary,
} from '@/lib/orders/clear-held-for-review-outcomes'
import {
  CLEAR_HELD_BANNER_COPY,
  CLEAR_HELD_CONTROL_COPY,
  CLEAR_HELD_OUTCOME_COPY,
} from '@/lib/orders/clear-held-for-review-copy'

export type HeldForReviewPanelProps = {
  rows: readonly HeldForReviewRow[]
  loading?: boolean
  /** Non-null when the read failed. The panel then says so rather than rendering empty. */
  error?: string | null
  currency?: string
  /**
   * The "clear all" action. Absent means the control is not rendered at all — which is what a
   * caller that cannot offer it (no handler wired, or the user lacks `orders:update`) must do. The
   * server checks the permission again regardless; hiding the button is a courtesy, never the gate.
   */
  onClearAll?: () => void | Promise<void>
  /** True when the signed-in user holds `orders:update`. Hides the control when false. */
  canClearAll?: boolean
  /** True while a run is in flight. Disables the control, which is what stops a double-submit. */
  clearing?: boolean
  /** The finished run, rendered per order. Null before the first run. */
  clearSummary?: ClearHeldSummary | null
  /** Non-null when the REQUEST failed, as opposed to the run completing with skips. */
  clearError?: string | null
  /**
   * The PER-ORDER manual override. Distinct from `onClearAll` in every way that matters: it names
   * one order, and it is a human overruling a safety rule rather than the rule running.
   */
  onOverrideCancel?: (orderId: string) => void | Promise<void>
  /** True when the signed-in user holds `orders:update`. Hides the control when false. */
  canOverride?: boolean
  /** The order currently being overridden, if any. Disables that one control. */
  overridingId?: string | null
  /** Per-order result of the last override, keyed by order id. Refusals land here too. */
  overrideMessages?: Record<string, string>
}

export function HeldForReviewPanel({
  rows,
  loading = false,
  error = null,
  currency = 'N$',
  onClearAll,
  canClearAll = false,
  clearing = false,
  clearSummary = null,
  clearError = null,
  onOverrideCancel,
  canOverride = false,
  overridingId = null,
  overrideMessages = {},
}: HeldForReviewPanelProps) {
  /**
   * TWO-STEP, IN-COMPONENT. Not `window.confirm`, which is untestable in jsdom without stubbing a
   * global, and not a toast, which can be missed. The confirmation states the count and the amount
   * because that is the blast radius, and it is the last point at which a staff member can stop.
   */
  const [confirming, setConfirming] = useState(false)

  /**
   * COLLAPSED BY DEFAULT. Eight identical cards is not information -- it is the same sentence
   * eight times, and a staff member scanning the dashboard reads none of them. The summary line
   * carries the three facts that actually differ between one board and another: how many, how
   * much, and how old the worst one is.
   *
   * Collapsed regardless of count, deliberately. A threshold ("collapse above three") is a rule
   * nobody asked for and it makes the surface behave differently on different days, which is
   * exactly how a staff member learns not to trust what it is showing them.
   */
  /**
   * EXCEPT WHEN A ROW CARRIES UNSIGNED COPY, in which case it opens.
   *
   * #353's guarantee is that an unsigned string is impossible to MISS — it exists because on
   * 2026-08-21 five of them reached production and the owner of a multi-location account read
   * `PENDING COPY — Location` on twenty staff screens. A collapse that folds unsigned wording
   * behind a tap re-creates that defect exactly, and it would do it silently: the marker would
   * still be in the DOM, still be greppable, still pass `check-no-pending-copy.mjs`, and simply
   * not be on screen.
   *
   * So the collapse applies to the case it was asked for -- eight identical, correctly-worded
   * cards -- and yields to the older guarantee when the two conflict.
   */
  const hasUnsignedCopy = rows.some((row) => !row.copySigned)
  const [expanded, setExpanded] = useState(hasUnsignedCopy)

  /** Which card is mid-confirmation. One at a time -- this is a per-order decision. */
  const [overrideConfirmingId, setOverrideConfirmingId] = useState<string | null>(null)
  if (error) {
    return (
      <section
        data-testid="held-for-review"
        data-state="error"
        className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold text-red-900">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          {HELD_FOR_REVIEW_SECTION_COPY.heading}
        </h2>
        {/*
          NOT "no orders held". The read failed, so this screen does not know whether anything is
          held, and saying nothing is held would be a statement it has no evidence for.
        */}
        <p data-testid="held-for-review-error" className="mt-1 text-sm text-red-900">
          This list could not be loaded, so it is not showing whether any orders are held.
        </p>
      </section>
    )
  }

  if (loading) {
    return (
      <section
        data-testid="held-for-review"
        data-state="loading"
        className="mb-6 rounded-lg border border-border bg-card p-4"
      >
        <h2 className="text-lg font-semibold">{HELD_FOR_REVIEW_SECTION_COPY.heading}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Checking…</p>
      </section>
    )
  }

  if (rows.length === 0) return null

  const total = rows.reduce((sum, row) => sum + row.total, 0)

  /**
   * The OLDEST held order's age, for the summary line. Null when no row carries a usable age --
   * `heldForMs` is nullable by design, because an order whose `placed_at` will not parse is
   * exactly as unresolved as one whose will, and dropping it would be the invisible-absence
   * failure this surface exists to remove. A null here hides the "oldest" clause; it never hides
   * the row.
   */
  const heldAges = rows
    .map((row) => row.heldForMs)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
  const oldestHeldMs = heldAges.length > 0 ? Math.max(...heldAges) : null
  const showClear = Boolean(onClearAll) && canClearAll
  const banner = clearSummary ? clearHeldBanner(clearSummary) : null

  return (
    <section
      data-testid="held-for-review"
      data-state="populated"
      className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-900">
          {HELD_FOR_REVIEW_SECTION_COPY.heading}{' '}
          <span data-testid="held-for-review-count" className="font-normal">
            ({rows.length})
          </span>
        </h2>
        <span data-testid="held-for-review-total" className="text-sm font-semibold text-amber-900">
          {currency}
          {heldAmountDigits(total)}
        </span>
      </div>
      <p data-testid="held-for-review-intro" className="mt-1 text-sm text-amber-900">
        {HELD_FOR_REVIEW_SECTION_COPY.intro}
      </p>

      {/*
        THE SUMMARY LINE. Count, amount, and the age of the OLDEST -- the oldest rather than an
        average, because the oldest is the one that has been ignored longest and is the reason to
        open this at all. An average would hide it behind seven fresh ones.
      */}
      <button
        type="button"
        data-testid="held-for-review-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 flex w-full items-center justify-between gap-3 rounded-md border border-amber-200 bg-card px-3 py-2 text-left"
      >
        <span className="text-sm font-semibold text-foreground">
          <span data-testid="held-summary-count">{rows.length}</span>
          {' held · '}
          <span data-testid="held-summary-total">
            {currency}
            {heldAmountDigits(total)}
          </span>
          {oldestHeldMs === null ? null : (
            <>
              {' · oldest '}
              <span data-testid="held-summary-oldest">{formatHeldDuration(oldestHeldMs)}</span>
            </>
          )}
        </span>
        <span aria-hidden className="text-sm text-muted-foreground">
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>

      {/*
        THE SIGNED WARNING IS NEVER COLLAPSED.

        The cards are redundant -- seven identical sentences -- and that redundancy is what folds
        away. The WARNING is not redundant, and #353 pins two of these sentences by name
        ("A card may still have been charged on the machine.", "Nothing has been taken from this
        order yet.") precisely so they cannot be shortened out or hidden. Folding them behind a tap
        would satisfy the collapse and quietly undo the guarantee that put them on the screen.

        One line per DISTINCT cause, so a board of seven identical holds shows the sentence once
        rather than seven times -- which is the collapse doing its job on the right thing.
      */}
      <ul data-testid="held-for-review-warnings" className="mt-2 grid gap-1">
        {[...new Set(rows.map((row) => row.why))].map((why) => (
          <li key={why} data-testid="held-row-why" className="text-sm text-muted-foreground">
            {why}
          </li>
        ))}
      </ul>

      {/*
        CONDITIONALLY RENDERED, not `hidden`. The first version used
        `<ul className="… grid …" hidden={!expanded}>`, which does nothing: Tailwind's `.grid`
        utility sets `display: grid` and beats preflight's `[hidden] { display: none }`, so the
        attribute was set on an element that stayed on screen. The collapse shipped to production
        looking correct in the DOM and doing nothing at all — seven cards, every one of them still
        there.
        Only loading the page catches that. A unit test asserting `aria-expanded` passes either
        way, which is exactly why the ones I wrote did.
      */}
      {expanded ? (
      <ul className="mt-2 grid gap-2">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="held-for-review-row"
            data-cause={row.cause}
            data-copy-signed={row.copySigned ? 'true' : 'false'}
            className="rounded-md border border-amber-200 bg-card px-3 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span data-testid="held-row-label" className="font-medium">
                {row.label}
              </span>
              {/* what is owed, how long it has been held, and the table */}
              <span className="text-sm text-muted-foreground">
                <span data-testid="held-row-amount" className="font-semibold text-foreground">
                  {currency}
                  {heldAmountDigits(row.total)}
                </span>
                {' · held '}
                <span data-testid="held-row-duration">{formatHeldDuration(row.heldForMs)}</span>
                {' · '}
                <span data-testid="held-row-table">
                  {row.table === null ? 'no table' : `Table ${row.table}`}
                </span>
              </span>
            </div>
            <p data-testid="held-row-why" className="mt-1 text-sm text-muted-foreground">
              {row.why}
            </p>

            {/*
              THE PER-ORDER OVERRIDE. Visibly distinct from "Clear all" below, and it has to be:
              that one is the rule running, this is a person overruling it. So it is destructive
              red rather than the panel's amber, it is a two-step, and its confirm text names the
              risk rather than the count.

              Hiding it without the permission is a courtesy. The route checks `orders:update`
              itself and 403s regardless -- the client never participates in an authorization
              decision.
            */}
            {onOverrideCancel && canOverride ? (
              <div data-testid="held-row-override" className="mt-2 border-t border-amber-100 pt-2">
                {overrideMessages[row.id] ? (
                  <p data-testid="held-row-override-message" className="text-sm text-amber-900">
                    {overrideMessages[row.id]}
                  </p>
                ) : overridingId === row.id ? (
                  <p data-testid="held-row-override-running" className="text-sm text-amber-900">
                    Checking with the payment provider…
                  </p>
                ) : overrideConfirmingId === row.id ? (
                  <div data-testid="held-row-override-confirm">
                    <p className="text-sm font-medium text-red-900">
                      {OVERRIDE_CANCEL_COPY.title}
                    </p>
                    <p
                      data-testid="held-row-override-confirm-body"
                      className="mt-1 text-sm text-red-900"
                    >
                      {OVERRIDE_CANCEL_COPY.body}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid="held-row-override-accept"
                        className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white"
                        onClick={() => {
                          setOverrideConfirmingId(null)
                          void onOverrideCancel(row.id)
                        }}
                      >
                        {OVERRIDE_CANCEL_COPY.confirm}
                      </button>
                      <button
                        type="button"
                        data-testid="held-row-override-cancel"
                        className="rounded-md border border-amber-300 px-3 py-1.5 text-sm"
                        onClick={() => setOverrideConfirmingId(null)}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="held-row-override-start"
                    disabled={Boolean(overridingId)}
                    className="text-sm font-medium text-red-700 underline underline-offset-2 disabled:opacity-50"
                    onClick={() => setOverrideConfirmingId(row.id)}
                  >
                    {OVERRIDE_CANCEL_COPY.button}
                  </button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      ) : null}

      {/*
        THE CONTROL. Rendered only when the caller supplied a handler AND the user holds
        `orders:update`. Hiding it is a courtesy — POST /api/admin/orders/held-for-review/clear
        checks the permission itself and 403s regardless, because the client never participates in
        an authorization decision.
      */}
      {showClear ? (
        <div data-testid="held-clear-control" className="mt-4 border-t border-amber-200 pt-3">
          {clearing ? (
            <p data-testid="held-clear-running" className="text-sm text-amber-900">
              {CLEAR_HELD_CONTROL_COPY.running}
            </p>
          ) : confirming ? (
            <div data-testid="held-clear-confirm">
              <p className="text-sm font-medium text-amber-900">
                {CLEAR_HELD_CONTROL_COPY.confirmHeading}
              </p>
              <p data-testid="held-clear-confirm-body" className="mt-1 text-sm text-amber-900">
                {CLEAR_HELD_CONTROL_COPY.confirmBody
                  .replace('{count}', String(rows.length))
                  .replace('{amount}', `${currency}${heldAmountDigits(total)}`)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="held-clear-confirm-accept"
                  className="rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white"
                  onClick={() => {
                    setConfirming(false)
                    void onClearAll?.()
                  }}
                >
                  {CLEAR_HELD_CONTROL_COPY.confirmAccept}
                </button>
                <button
                  type="button"
                  data-testid="held-clear-confirm-cancel"
                  className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-900"
                  onClick={() => setConfirming(false)}
                >
                  {CLEAR_HELD_CONTROL_COPY.confirmCancel}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="held-clear-button"
              className="rounded-md border border-amber-400 bg-card px-3 py-1.5 text-sm font-medium text-amber-900"
              onClick={() => setConfirming(true)}
            >
              {CLEAR_HELD_CONTROL_COPY.button}
            </button>
          )}

          {/*
            A FAILED REQUEST NEVER RENDERS AS AN EMPTY RESULT. Same rule as the panel's own error
            state above: the three states must stay impossible to confuse, and "the check could not
            be run" is not "there was nothing to do".
          */}
          {clearError ? (
            <p data-testid="held-clear-request-error" className="mt-2 text-sm font-medium text-red-900">
              {CLEAR_HELD_CONTROL_COPY.requestFailed}
            </p>
          ) : null}

          {clearSummary ? (
            <div data-testid="held-clear-results" className="mt-3">
              {/*
                The banner comes FIRST and is the loudest thing here. Its whole job is to stop a
                staff member reading "six orders untouched" as "six orders were fine" when the truth
                is that nothing could be checked at all.
              */}
              {banner ? (
                <p
                  data-testid="held-clear-banner"
                  data-banner={banner}
                  className="mb-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900"
                >
                  {CLEAR_HELD_BANNER_COPY[banner]}
                </p>
              ) : null}
              <p className="text-sm font-medium text-amber-900">
                {CLEAR_HELD_CONTROL_COPY.resultsHeading}
              </p>
              <ul className="mt-2 grid gap-1">
                {clearSummary.outcomes.map((outcome) => (
                  <li
                    key={outcome.orderId}
                    data-testid="held-clear-result-row"
                    data-order-id={outcome.orderId}
                    data-outcome={outcome.outcome}
                    data-gateway-code={outcome.gatewayCode}
                    data-wrote={outcome.wrote ? 'true' : 'false'}
                    className="text-sm text-amber-900"
                  >
                    <span data-testid="held-clear-result-order" className="font-semibold">
                      {/*
                        hasAllocatedOrderNumber, not a null check: `0` is not a legal order number
                        and rendering "#0" is the exact defect scripts/check-order-number-guard.ts
                        exists to catch — it caught this line. An order with no allocated number
                        falls back to its id, which is at least findable, rather than to a number it
                        never had.
                      */}
                      {hasAllocatedOrderNumber({ order_number: outcome.orderNumber })
                        ? `#${outcome.orderNumber}`
                        : outcome.orderId}
                    </span>
                    {' · '}
                    <span data-testid="held-clear-result-amount">
                      {currency}
                      {heldAmountDigits(outcome.total)}
                    </span>
                    {' · '}
                    <span data-testid="held-clear-result-text">
                      {CLEAR_HELD_OUTCOME_COPY[outcome.outcome]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export default HeldForReviewPanel
