/**
 * The "clear all" VOCABULARY and the shapes it travels in. NO IMPORTS, deliberately.
 *
 * WHY THIS IS A SEPARATE FILE FROM `clear-held-for-review.ts`, WHICH IS WHERE YOU WOULD LOOK FIRST.
 *
 * The action itself imports `getRestaurantFinaticCredentials`, which imports the restaurant cache,
 * which imports `lib/redis.ts`, which imports `@upstash/redis`. `components/held-for-review-panel.tsx`
 * is a `'use client'` component and it needs the outcome names, the summary type and the banner
 * derivation to render a result. Importing them from the action module pulled that whole server
 * chain behind them: an ESM-only Redis client into the browser bundle, and — the way it was actually
 * found — a jest suite that could not parse `uncrypto/dist/crypto.web.mjs` and died before running a
 * single assertion.
 *
 * That is the same family as the `jose` gotcha (`lib/terminal-auth.ts` cannot be loaded by ts-jest at
 * all), and the fix is the same shape as `lib/payments/finatic-credentials-error.ts`: the piece both
 * sides need lives on its own, importing nothing, so neither side drags the other's dependencies
 * along. `clear-held-for-review.ts` re-exports everything here, so existing import paths keep
 * working and there is one obvious place to look.
 *
 * NOTHING IN THIS FILE MAY GAIN AN IMPORT. A single one puts the server chain back in the client
 * bundle, silently, and the only thing that would notice is a suite failing to parse.
 */

/**
 * Every outcome an order can receive. THE LIST IS THE VOCABULARY — a caller renders from it, the
 * summary counts by it, and an order that reached the action always carries exactly one.
 *
 * There is deliberately no `skipped` and no `error`. A name that does not say WHY is the silent skip
 * with a label on it, which is the failure this whole surface exists to remove.
 */
export const CLEAR_HELD_OUTCOMES = [
  /** Gateway gave a positively-established unpaid answer. Order cancelled, trail written. */
  'cancelled',
  /** Gateway confirmed a payment agreeing with the order total. Marked paid, NOT cancelled. */
  'gateway_confirmed_paid',
  /**
   * Gateway confirmed a payment whose amount does not agree with the order total (or carried no
   * amount at all). Neither paid nor cancelled — quarantined for a human, #223.
   */
  'gateway_paid_amount_disagrees',
  /** The venue has no Finatic credentials, so nobody can ask. Left held, never cancelled. */
  'unverifiable_no_credentials',
  /** No paycloud_merchant_order_no, so there is nothing to ask the gateway about. Left held. */
  'unverifiable_no_gateway_reference',
  /** The gateway call threw something that was neither E04111 nor a credentials problem. */
  'skipped_gateway_unreachable',
  /**
   * Gateway has no record of the reference (E04111) BUT the order carries a payment marker, so
   * something did reach the gateway once. E04111 alone is not "no charge"; with a marker present it
   * is a contradiction, and a contradiction is not a licence to cancel.
   */
  'skipped_gateway_no_record_but_marker_present',
  /** The gateway answered with a trans_status this codebase does not recognise. Unknown is not unpaid. */
  'skipped_gateway_status_unrecognised',
  /**
   * The order is already at `amount_mismatch_hold`: a gateway has ALREADY confirmed a payment for
   * it. Cancelling it would cancel a charged card. Out of this action's scope by design.
   */
  'skipped_gateway_confirmed_payment_already_held',
  /** It left the held set between enumeration and the write — settled, cancelled, or moved. */
  'skipped_already_resolved',
  /** The venue's positive control did not come back PAID, so no answer in this run is trustworthy. */
  'skipped_control_failed',
  /** The venue has no known-paid order carrying a gateway reference, so no control can be formed. */
  'skipped_control_unavailable',
  /** Over MAX_CLEARED_PER_RUN. Untouched, still held, picked up by the next press. */
  'deferred_run_cap',
] as const

export type ClearHeldOutcome = (typeof CLEAR_HELD_OUTCOMES)[number]

/** Outcomes that wrote a money column. Everything else left the order exactly as it was. */
const OUTCOMES_THAT_WROTE: readonly ClearHeldOutcome[] = [
  'cancelled',
  'gateway_confirmed_paid',
  'gateway_paid_amount_disagrees',
]

export function clearHeldOutcomeWrote(outcome: ClearHeldOutcome): boolean {
  return OUTCOMES_THAT_WROTE.includes(outcome)
}

/** What the control ask returned, normalised. Only `passed` permits a write. */
export type ControlVerdict =
  | 'passed'
  | 'failed_not_paid'
  | 'failed_gateway_error'
  | 'unavailable_no_candidate'
  | 'unavailable_no_credentials'

export type ClearHeldControl = {
  /** The order used as the control, or null when none could be formed. */
  orderId: string | null
  orderNumber: number | null
  verdict: ControlVerdict
  /** How many times the control was re-asked in this run — once per candidate reached. */
  asks: number
  /**
   * True when the control order carries NEITHER payment_reference NOR payment_voucher_no.
   *
   * The manual sweep chose such an order on purpose (FNB ChowNow #546) because it exercises exactly
   * the false positive that would do the damage: an order that IS paid while looking, locally, like
   * one that never reached the gateway. Recorded so a reader can tell a strong control from a
   * merely adequate one.
   */
  markerless: boolean
  /** Gateway detail from the last ask, for the audit row. */
  lastGatewayCode: string
  note: string | null
}

export type ClearHeldOrderResult = {
  orderId: string
  restaurantId: string
  orderNumber: number | null
  total: number
  channel: string
  cause: string
  outcome: ClearHeldOutcome
  /**
   * The gateway's answer for THIS order, from THIS run. Never null, never inherited: 'NOT_ASKED'
   * when no call was made, with `gatewayNote` saying why.
   */
  gatewayCode: string
  gatewayStatus: string | null
  gatewayAmount: number | null
  /** ISO timestamp of the ask, or null when no ask was made. */
  gatewayAskedAt: string | null
  gatewayNote: string | null
  /** The control verdict standing behind this order's decision. */
  controlVerdict: ControlVerdict
  /** True when a money column was written for this order by this run. */
  wrote: boolean
}

export type ClearHeldVenueResult = {
  restaurantId: string
  control: ClearHeldControl
  orderIds: string[]
}

export type ClearHeldSummary = {
  startedAt: string
  finishedAt: string
  /** The user this run is attributed to, from the route's session. Null only in tests. */
  requestedBy: string | null
  venues: ClearHeldVenueResult[]
  outcomes: ClearHeldOrderResult[]
  counts: Record<ClearHeldOutcome, number>
  cancelledIds: string[]
  paidIds: string[]
  heldForAmountReviewIds: string[]
  unverifiableIds: string[]
  skippedIds: string[]
  /** Every outbound Finatic call this run made, controls included. */
  gatewayAsks: number
  gatewayAsksFailed: number
  /**
   * THE DISTINGUISHER THE OWNER ASKED FOR, as a field rather than as something a reader has to
   * derive by comparing two counts.
   *
   * True when the run made at least one gateway call and EVERY one of them failed. A run in that
   * state has learned nothing about any order, and it must be impossible to mistake for a run in
   * which six orders were genuinely unpaid. It is `true` for exactly the situation where those two
   * runs would otherwise produce the same list of six untouched orders.
   */
  allGatewayCallsFailed: boolean
}

/**
 * The ONE thing a run needs to say above the per-order list, or null when the per-order lines say
 * it all by themselves.
 *
 * A DERIVATION, NOT A RENDER DECISION, which is why it lives here next to the outcomes rather than
 * in the component. It is the answer to "could a staff member read this result as 'none of these
 * were paid' when the truth is 'nothing could be checked'", and that question must be answerable
 * from the summary object alone — by a test, by a script, and by a future second surface — not only
 * by looking at a screen.
 *
 * ORDERED BY SEVERITY, MOST MISLEADING FIRST. Each earlier case can produce the same *looking*
 * result as a later one, so the earliest that applies wins.
 */
export type ClearHeldBanner =
  | 'all_gateway_calls_failed'
  | 'control_failed'
  | 'no_credentials'
  | 'control_unavailable'
  | 'nothing_changed'
  | null

export function clearHeldBanner(summary: ClearHeldSummary): ClearHeldBanner {
  // Every single call out failed: the run learned NOTHING. This must outrank everything, because
  // its untouched-orders list is byte-identical to a run in which every order was genuinely fine.
  if (summary.allGatewayCallsFailed) return 'all_gateway_calls_failed'

  const verdicts = summary.venues.map((v) => v.control.verdict)
  if (verdicts.some((v) => v === 'failed_not_paid' || v === 'failed_gateway_error'))
    return 'control_failed'
  if (verdicts.some((v) => v === 'unavailable_no_credentials')) return 'no_credentials'
  if (summary.counts.skipped_control_unavailable > 0) return 'control_unavailable'

  if (summary.outcomes.length > 0 && !summary.outcomes.some((o) => o.wrote)) return 'nothing_changed'
  return null
}

/** Ceiling on orders processed in one press. See the action module for why this number exists. */
export const MAX_CLEARED_PER_RUN = 25
