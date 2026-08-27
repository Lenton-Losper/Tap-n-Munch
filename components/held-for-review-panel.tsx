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
import { AlertTriangle } from 'lucide-react'
import {
  HELD_FOR_REVIEW_SECTION_COPY,
  formatHeldDuration,
  heldAmountDigits,
  type HeldForReviewRow,
} from '@/lib/orders/held-for-review'

export type HeldForReviewPanelProps = {
  rows: readonly HeldForReviewRow[]
  loading?: boolean
  /** Non-null when the read failed. The panel then says so rather than rendering empty. */
  error?: string | null
  currency?: string
}

export function HeldForReviewPanel({
  rows,
  loading = false,
  error = null,
  currency = 'N$',
}: HeldForReviewPanelProps) {
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

      <ul className="mt-3 grid gap-2">
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
          </li>
        ))}
      </ul>
    </section>
  )
}

export default HeldForReviewPanel
