/**
 * "Clear all" for the Held for review surface — ONE action, run by a person, that asks the gateway
 * about every held order and then does the only three things it is allowed to do: cancel what is
 * confirmed unpaid, surface what is confirmed paid, and NAME everything else.
 *
 * THE OWNER'S FRAMING. "These are abandoned sale flows — staff rang them up, the payment never
 * completed, the cron won't cancel them because they carry a gateway reference. They will keep
 * accumulating. Staff should not have to decide one at a time when the answer for all six is the
 * same."
 *
 * WHY THE CRON CANNOT DO THIS AND THIS IS NOT A SECOND CRON. `autoCancelStalePosOrders` reaches an
 * order carrying a `paycloud_merchant_order_no` only through the Finatic loop, and every answer it
 * can get for these six — E04111 — is classified `skippedUncertain` and left `pending`, forever, by
 * the 2026-08-05 ruling. That ruling is correct: a SINGLE E04111 is never terminal (order #149
 * returned E04111 at 13:58:48 and was confirmed PAID on the same reference 22 seconds later). What
 * makes a cancel defensible here is not a better rule, it is a PERSON deciding, with a live
 * positive control standing behind the query path. So this module is only ever reached from a
 * human-initiated request, never from a schedule.
 *
 * ================================================================================================
 * THE GUARD, WHICH IS THE WHOLE MODULE. Taken verbatim from the manual sweep that has already been
 * run against production by hand — scripts/prod/cancel-stranded-20260825.ts — because the point of
 * building this is to stop that script being retyped, not to invent a weaker version of it.
 *
 *   1. EVERY ORDER IS RE-QUERIED AGAINST FINATIC IN THE SAME RUN, IMMEDIATELY BEFORE ITS OWN
 *      WRITE. Never from a list gathered earlier. This function takes NO list of order ids from
 *      its caller at all (see `clearHeldForReview`'s params) — it enumerates the held set itself
 *      and then RE-READS each row a second time immediately before touching it, because between
 *      the enumeration and the write a terminal callback may have settled it.
 *
 *   2. A LIVE POSITIVE CONTROL PER VENUE, RE-ASKED FOR EVERY CANDIDATE. A known-paid order at the
 *      same venue, on the same credentials, queried in the same iteration. If the control does not
 *      come back PAID, the venue's remaining orders are abandoned untouched and NAMED.
 *
 *      THIS IS THE LOAD-BEARING HALF AND IT IS NOT OPTIONAL. A broken query path — wrong
 *      credentials, an expired session, a gateway outage — answers "error" or "not paid" for
 *      EVERYTHING, and that is exactly the answer that authorises a cancel. Without a control,
 *      "all six are unpaid" and "the gateway is down" are the same observation. This codebase has
 *      already shipped a security chain that went green during a total customer lockout for
 *      precisely that reason; see the false-negatives ledger. An instrument that would look
 *      identical if the thing it watches were completely broken is not an instrument.
 *
 *   3. CANCEL ONLY WHAT COMES BACK UNPAID. Two positively-established gateway answers qualify and
 *      they are recorded under DIFFERENT bases so the audit trail says which rule fired — see
 *      `decideFromGateway`.
 *
 *   3b. AN E04111 IS NOT ONE OF THEM UNTIL IT HAS PERSISTED. Owner ruling, 2026-08-27, implemented
 *      once in `e04111PersistenceAuthorisesCancel` and applied here: 72h since
 *      `orders.payment_attempt_started_at`, two recorded observations at least 24h apart, AND a
 *      fresh query in this run. All three, conjunctively, or the order is left exactly as it is
 *      under one of four named refusals.
 *
 *      THIS BRANCH IS THE ONE THAT WOULD HAVE BEEN TOO PERMISSIVE. Cancelling on a live E04111
 *      alone is a decision taken on a single sample of a system that was MEASURED changing its
 *      answer in 22 seconds — order #149 answered E04111 at 13:58:48 and was confirmed PAID on the
 *      same reference at 13:59:10. The 2026-08-05 ruling ("a single E04111 is never terminal") and
 *      the 2026-08-27 ruling ("a persistent one is") do not contradict each other; each bounds the
 *      other, and the boundary is TIME. Read both in lib/payments/query-finatic-order-paid.ts.
 *
 *      The cancel's audit row says which of the two rules authorised it — `authorisedBy:
 *      'e04111_persistence_rule'` — with the age, the observation count and the span it was decided
 *      on. An E04111 cancel is NEVER a `paid=false` answer: that call throws rather than returning,
 *      so no such answer exists for these orders, and the row says so in words.
 *
 *   4. ANYTHING PAID IS NEVER CANCELLED. It goes through `markOrderPaidConfirmed`, the single
 *      writer for "this order is confirmed paid", so it lands in the identical state with the
 *      identical trail as a live terminal callback.
 *
 *   5. ANYTHING UNVERIFIABLE OR UNREACHABLE IS SKIPPED AND NAMED. A silent skip is the failure
 *      mode this surface exists to remove one level up; reproducing it inside the button would be
 *      the same defect wearing the fix's clothes. Every order the run looked at appears in
 *      `outcomes` with a name from `CLEAR_HELD_OUTCOMES`, and every one of those names says what
 *      happened rather than merely that nothing did.
 *
 *   6. AUDITED, WITH THE FRESH GATEWAY CODE ON EACH ORDER. `gatewayCode` is never null and never
 *      inherited from an earlier run: 'NOT_ASKED' when no call was made, and the reason it was not
 *      made is in the same row.
 * ================================================================================================
 *
 * VENUES WITH NO FINATIC CREDENTIALS CANNOT BE VERIFIED BY ANYONE — not by this button, not by the
 * cron, not by a person with a terminal. 8 of 11 production venues have none (measured 2026-08-26,
 * #153). Their orders are reported `unverifiable_no_credentials` and LEFT HELD. They are never
 * cancelled on the strength of "we could not ask": the device-side WiseCashier flow charges under
 * the reader's own merchant, which this system never records, so an empty credentials column is not
 * evidence of an uncharged card. The recorded precedent is Digi Cofee #19, resolved by hand with a
 * cancellation_reason that says exactly this.
 *
 * The credential discrimination is `isMissingFinaticCredentialsError`, imported from
 * lib/payments/finatic-credentials-error. There is deliberately no second predicate here — see
 * that module's header for why it lives alone and why a duplicate would silently stop working
 * inside the eighteen suites that factory-mock the throwing module.
 *
 * PARTIAL FAILURE MUST NOT LOSE THE SUCCESSES. There is no transaction across the gateway calls and
 * there must not be: an all-or-nothing run of six network calls discards five correct answers when
 * the sixth times out. Every order is decided, written and recorded on its own, and the summary is
 * assembled from what actually happened. Nothing in this file throws on a per-order failure; the
 * only throws left are the audit-insert throws inside the shared writers, which are caught per
 * order and degrade that ONE order to a named skip.
 *
 * IDEMPOTENT BY CONSTRUCTION, NOT BY A FLAG. Two taps, a double-submit, or two staff members on two
 * tills:
 *   - the enumeration re-runs, so an order resolved by the first tap is no longer a candidate;
 *   - the re-read before each write drops anything that moved since enumeration;
 *   - `cancelOrderWithTrail(guard: 'require_pending')` re-asserts `payment_status='pending'` in the
 *     UPDATE itself, so the second writer matches zero rows and reports `cancelled: false`;
 *   - `markOrderPaidConfirmed` claims atomically and the loser gets `claimed: false`.
 * A double-tap therefore produces a second run whose orders all read `skipped_already_resolved`.
 * That is the correct output, and it is asserted rather than assumed —
 * __tests__/clear-held-for-review.test.ts.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  E04111_MIN_OBSERVATION_SEPARATION_MS,
  E04111_PERSISTENCE_CANCEL_MS,
  e04111PersistenceAuthorisesCancel,
  finaticErrorCode,
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
  type E04111PersistenceVerdict,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
  amountsMatch,
  GATEWAY_AMOUNT_TOLERANCE_CENTS,
  HELD_FOR_REVIEW_PAYMENT_STATUSES,
  VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
} from '@/lib/payments/payment-integrity'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { cancelOrderWithTrail, type CancelBasis } from './cancel-order-with-trail'
import { holdForAmountReview } from './auto-cancel-stale-pos-orders'
import { hasAllocatedOrderNumber } from './order-identity'
import {
  heldForReviewCause,
  STRANDED_PENDING_CAUSE,
  STRANDED_PENDING_THRESHOLD_MS,
  type HeldForReviewCandidate,
} from './held-for-review'
import {
  CLEAR_HELD_OUTCOMES,
  MAX_CLEARED_PER_RUN,
  clearHeldOutcomeWrote,
  type ClearHeldControl,
  type ClearHeldOrderResult,
  type ClearHeldOutcome,
  type ClearHeldSummary,
  type ClearHeldVenueResult,
} from './clear-held-for-review-outcomes'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * audit_logs.action written for an order this run looked at and did NOT write a money column for.
 *
 * A DISTINCT ACTION FROM `payment.verification_skipped`, which is the cron's. That one means "asked,
 * no confident answer, will ask again in an hour". This one means "a person pressed the button and
 * this is what happened to this order", and the two must be countable apart — merging them is how
 * 743 rows across 18 orders once looked like activity instead of a stall (#153).
 */
export const HELD_CLEAR_SKIPPED_ACTION = 'held_for_review.clear_skipped'

/**
 * audit_logs.action written ONCE PER VENUE PER RUN recording the positive control's identity and
 * verdict.
 *
 * WITHOUT THIS ROW A FAILED RUN IS INVISIBLE. When the control fails, nothing else is written by
 * definition — no cancel, no correction — so a run that was aborted by a broken gateway would leave
 * the database looking exactly like a run that never happened. Rule 21: ask where the report LANDS.
 * A console.error in a Cloudflare worker is not somewhere the owner can query. This row is.
 */
export const HELD_CLEAR_CONTROL_ACTION = 'held_for_review.clear_control'

/**
 * THE VOCABULARY LIVES IN `clear-held-for-review-outcomes.ts` AND IS RE-EXPORTED HERE.
 *
 * Not for tidiness. `components/held-for-review-panel.tsx` is a `'use client'` component and needs
 * the outcome names, the summary shape and the banner derivation to render a result. Importing them
 * from THIS module pulls `getRestaurantFinaticCredentials` -> the restaurant cache -> `lib/redis.ts`
 * -> `@upstash/redis` behind them: an ESM-only Redis client into the browser bundle, and a jest
 * suite that dies parsing `uncrypto/dist/crypto.web.mjs` before it runs an assertion. That is how it
 * was found. Same family as the `jose` gotcha, same fix as `finatic-credentials-error.ts`.
 *
 * Re-exported so every existing import path keeps working and there is one obvious place to look.
 */
export {
  CLEAR_HELD_OUTCOMES,
  MAX_CLEARED_PER_RUN,
  clearHeldBanner,
  clearHeldOutcomeWrote,
} from './clear-held-for-review-outcomes'
export type {
  ClearHeldBanner,
  ClearHeldControl,
  ClearHeldOrderResult,
  ClearHeldOutcome,
  ClearHeldSummary,
  ClearHeldVenueResult,
  ControlVerdict,
} from './clear-held-for-review-outcomes'


const NOT_ASKED = 'NOT_ASKED'

function emptyCounts(): Record<ClearHeldOutcome, number> {
  const counts = {} as Record<ClearHeldOutcome, number>
  for (const name of CLEAR_HELD_OUTCOMES) counts[name] = 0
  return counts
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * The columns every decision below reads. Selected once, re-selected on the fresh read.
 *
 * `payment_attempt_started_at` IS SELECTED BECAUSE THE E04111 RULING IS MEASURED FROM IT, and a
 * column that is written but never selected is a fix that ships inert — this repo has already done
 * exactly that once, with `customer_edited_at` on the #306 route, where tsc and the unit tests were
 * both blind to it. If it is not in this list the age test reads `undefined` for every order and
 * every E04111 refuses with `no_attempt_timestamp`, which fails SAFE and therefore silently.
 */
const ORDER_COLUMNS =
  'id, restaurant_id, order_number, total, status, payment_status, payment_method, channel, placed_at, table_number, paycloud_merchant_order_no, payment_reference, payment_voucher_no, paid_at, payment_attempt_started_at'

type OrderRow = {
  id: string
  restaurant_id: string
  order_number: number | null
  total: number | null
  status: string | null
  payment_status: string | null
  channel: string | null
  placed_at: string | null
  table_number: number | null
  /** Selected so the control's own row can be ASSERTED to be a card order, not merely filtered. */
  payment_method?: string | null
  paycloud_merchant_order_no: string | null
  payment_reference: string | null
  payment_voucher_no: string | null
  paid_at: string | null
  payment_attempt_started_at: string | null
}

/**
 * The held set, read fresh.
 *
 * TWO QUERIES, NOT ONE `.or()`, and NO `is_closed` FILTER — both for the reasons already written
 * down in `getHeldForReviewOrders`: `.or()`'s argument is a string parsed server-side and this file
 * has no business opening that seam, and every stale pending order on production carries
 * `is_closed = true`, so the filter every other read in the app uses would return zero rows here.
 *
 * NOT `getHeldForReviewOrders` ITSELF, and the reason is not style. That function is bound to the
 * module-level anon browser client in lib/supabase/orders.ts. This runs server-side under the
 * service role, on the client the caller hands in, which is also what makes it testable against a
 * double. The CLASSIFICATION is reused — `heldForReviewCause` decides membership below, so this
 * action can never disagree with the screen about what is held.
 */
async function readHeldOrders(
  supabase: Supabase,
  restaurantId: string,
  thresholdMs: number,
  nowMs: number,
): Promise<OrderRow[]> {
  const cutoff = new Date(nowMs - thresholdMs).toISOString()

  const held = await fetchAllRows<OrderRow>(
    supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('restaurant_id', restaurantId)
      .in('payment_status', [...HELD_FOR_REVIEW_PAYMENT_STATUSES])
      .order('placed_at', { ascending: true }),
    { label: 'clearHeldForReview:held' },
  )

  const stranded = await fetchAllRows<OrderRow>(
    supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('restaurant_id', restaurantId)
      .eq('payment_status', 'pending')
      .lt('placed_at', cutoff)
      .order('placed_at', { ascending: true }),
    { label: 'clearHeldForReview:stranded' },
  )

  // Dedupe by id, same as the surface: a future status that is both `pending` and a member of the
  // held set would otherwise be processed twice, and processing a money row twice in one run is
  // the double-cancel this action is required not to be capable of.
  const byId = new Map<string, OrderRow>()
  for (const row of [...(held ?? []), ...(stranded ?? [])]) {
    const id = trimmed(row?.id)
    if (id) byId.set(id, row)
  }
  return [...byId.values()]
}

/**
 * Pick the venue's positive control: a known-paid order at this venue carrying a gateway reference.
 *
 * PREFERS A MARKERLESS ONE. An order that is paid while carrying neither `payment_reference` nor
 * `payment_voucher_no` is the hard case — locally it looks exactly like an order that never reached
 * the gateway — so a control of that shape tests the query path against the precise false positive
 * that would cancel a real charge. Three such orders exist at FNB ChowNow (#456, #500, #546,
 * measured 2026-08-25) and the manual sweep deliberately used #546. Where a venue has none, the
 * most recently paid order with a reference is used and `markerless` records that the control is
 * the weaker kind.
 *
 * MOST RECENT FIRST, deliberately. A control the gateway has aged out of would fail and abort the
 * venue — the safe direction, but a pointless abort, so do not go looking in the far past for one.
 *
 * ONE CONTROL, NOT A LIST TO TRY UNTIL ONE PASSES. Retrying different controls until one comes back
 * PAID is a fishing expedition, and it converts the guard into a formality: given enough candidates
 * something eventually answers, and the run proceeds on a query path that has already been shown to
 * be unreliable.
 *
 * ============================================================================================
 * IT MUST BE A CARD ORDER. Found in production 2026-08-27, and it made the guard useless.
 * ============================================================================================
 *
 * This selected on `payment_status = 'paid'` plus "has a gateway reference" and never looked at
 * `payment_method`. At Riviera the most recent order matching that is **order #12, paid in CASH**
 * — a card payment was prepared (which mints the `FT` reference), then the bill was settled in
 * cash. The reference exists; the card was never charged. So Finatic has never heard of it and
 * answers E04111, correctly.
 *
 * Measured, both against the live gateway on the same credentials in the same run:
 *
 *     #12  cash, FT17870967741284193  ->  E04111, no record
 *     #6   card, FT17865507287746658  ->  paid=true, status=2, N$20
 *
 * So the control failed, every candidate was refused as `skipped_control_failed`, and the button
 * could never clear anything at Riviera — while a perfectly good known-paid card order sat one row
 * further down. A guard that cannot pass is indistinguishable from a guard doing its job, which is
 * the exact failure this whole surface was built to avoid; having a positive control is not enough
 * if the control's SUBJECT guarantees the wrong answer.
 *
 * `payment_method = 'card'` is therefore part of what makes an order a control at all, not a
 * refinement of the ordering.
 */
async function pickControl(
  supabase: Supabase,
  restaurantId: string,
): Promise<{ row: OrderRow; markerless: boolean } | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('restaurant_id', restaurantId)
    .eq('payment_status', 'paid')
    // See the block above: a CASH order can carry a gateway reference and the gateway will never
    // have heard of it. Without this the control asks about a payment that was never made.
    .eq('payment_method', 'card')
    .not('paycloud_merchant_order_no', 'is', null)
    .order('paid_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (error) throw error
  const rows = ((data ?? []) as OrderRow[]).filter(
    (row) => trimmed(row.paycloud_merchant_order_no) !== '',
  )
  if (rows.length === 0) return null

  const markerless = rows.find(
    (row) => !trimmed(row.payment_reference) && !trimmed(row.payment_voucher_no),
  )
  if (markerless) return { row: markerless, markerless: true }
  return { row: rows[0], markerless: false }
}

type GatewayAnswer =
  | { kind: 'answered'; paid: boolean; statusRecognised: boolean; status: string; amount: number | null; transactionId: string | null; code: string }
  | { kind: 'no_record'; code: string; message: string }
  | { kind: 'no_credentials'; code: string; message: string }
  | { kind: 'error'; code: string; message: string }

/**
 * One Finatic call, with every failure shape turned into a value rather than a throw.
 *
 * THE THREE FAILURE SHAPES ARE NOT ONE. `no_credentials` is permanent and nothing external will
 * resolve it; `no_record` (E04111) means the gateway has no such reference *yet*; `error` is
 * transient. Collapsing them is what produced the forever-retry #153 fixed and the mass-cancel the
 * 2026-08-05 removal prevented, so they stay apart from the moment the call returns.
 */
async function ask(
  queryFn: typeof queryFinaticOrderPaid,
  params: { merchantOrderNo: string; merchantNo: string; storeNo: string },
): Promise<GatewayAnswer> {
  try {
    const result = await queryFn(params)
    return {
      kind: 'answered',
      paid: result.paid,
      statusRecognised: result.statusRecognised,
      status: result.status,
      amount: typeof result.amount === 'number' && Number.isFinite(result.amount) ? result.amount : null,
      transactionId: result.transactionId ?? null,
      // The FRESH gateway code for this order, from this call. For a successful query the code IS
      // the status the gateway reported.
      code: trimmed(result.status).toUpperCase() || 'UNKNOWN',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingFinaticCredentialsError(err)) {
      return { kind: 'no_credentials', code: 'NO_CREDENTIALS', message }
    }
    if (isFinaticMerchantOrderInvalidError(err)) {
      return { kind: 'no_record', code: 'E04111', message }
    }
    return { kind: 'error', code: finaticErrorCode(err) ?? 'GATEWAY_ERROR', message }
  }
}

/**
 * How many recorded E04111 observations to read for one reference.
 *
 * THE TRUNCATION DIRECTION IS THE WHOLE REASON THIS IS SAFE. Rows come back OLDEST FIRST, so if a
 * reference has more observations than this the ones dropped are the NEWEST, and the span computed
 * from what remains is SHORTER than the real one. A shorter span can only ever refuse a cancel that
 * the full history would have authorised. Truncation errs toward leaving the order alone, which is
 * the only direction this action is allowed to be wrong in.
 *
 * Measured 2026-08-27: the six live Mingle cases carry 103 to 106 rows each, spanning 14 days. 500
 * is four to five times the observed worst case.
 */
const E04111_OBSERVATION_READ_LIMIT = 500

/**
 * The recorded E04111 observations for ONE gateway reference, oldest first.
 *
 * KEYED ON `metadata->>'businessOrderNo'`, NOT ON `entity_id`. The reference is what the gateway was
 * asked about; the order id is what we were asking on behalf of. Those come apart — an order that is
 * re-presented gets a new `paycloud_merchant_order_no`, and observations of the OLD reference say
 * nothing about the new one. Keying on the reference is what makes "this reference has been unknown
 * to the gateway for two weeks" a true sentence rather than a plausible one.
 *
 * NO ACTION FILTER, DELIBERATELY. Two writers record these today — the auto-cancel cron's
 * `payment.verification_skipped` and `handleTerminalPaymentFailed`'s
 * `payment.verification_uncertain` — and both carry `isE04111` and `businessOrderNo` in the same
 * metadata shape. Naming the actions here would mean a third writer's observations were silently not
 * counted, and "silently not counted" on this path shows up as an order that will not clear.
 *
 * A READ FAILURE RETURNS AN EMPTY LIST, WHICH REFUSES. It does not throw and it does not fall back:
 * with no observations the ruling's second condition cannot hold, the order is left exactly as it
 * was, and the outcome names the reason. An unrelated read failure must never become a cancel.
 */
async function readE04111Observations(
  supabase: Supabase,
  restaurantId: string,
  merchantOrderNo: string,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('created_at')
      .eq('restaurant_id', restaurantId)
      // PostgREST JSON-path equality. `.eq()` is parser-free — the value never reaches the
      // filter-string parser — so a reference containing a comma or a parenthesis cannot alter
      // the query. `.or()` would not have that property.
      .eq('metadata->>businessOrderNo', merchantOrderNo)
      .eq('metadata->>isE04111', 'true')
      .order('created_at', { ascending: true })
      .limit(E04111_OBSERVATION_READ_LIMIT)
    if (error) throw error
    return ((data ?? []) as Array<{ created_at: string | null }>)
      .map((row) => trimmed(row?.created_at))
      .filter((t) => t !== '')
  } catch (err) {
    console.error(
      `[clearHeldForReview] could not read E04111 observations for ${merchantOrderNo}; ` +
        'treating the history as empty, which REFUSES the cancel:',
      err,
    )
    return []
  }
}

/**
 * The ruling's refusal reason -> the outcome the staff member reads.
 *
 * ONE OUTCOME PER REASON, because they are four different situations with two different next
 * actions — three resolve by waiting and `no_attempt_timestamp` never does. A single "skipped" name
 * covering all four would tell a staff member to wait for something that is not coming.
 */
const E04111_REFUSAL_OUTCOME: Record<
  Exclude<E04111PersistenceVerdict['reason'], 'persisted_beyond_threshold'>,
  ClearHeldOutcome
> = {
  too_recent: 'skipped_e04111_too_recent',
  insufficient_observations: 'skipped_e04111_insufficient_observations',
  observations_too_close_together: 'skipped_e04111_observations_too_close_together',
  no_attempt_timestamp: 'skipped_e04111_no_attempt_timestamp',
  /**
   * STRUCTURALLY UNREACHABLE FROM THIS CALL SITE, and mapped anyway.
   *
   * `reconfirmedNow` is passed as a literal `true` exactly one statement after a live gateway call
   * that answered E04111, so this reason cannot be returned here — asserted by the suite. It is
   * mapped rather than omitted because the alternative is an order that reaches no branch and gets
   * no outcome at all, which is the invisible skip this vocabulary exists to end.
   *
   * It takes the `too_recent` NAME because the four names differ only in the sentence a staff
   * member reads, and "leave it, run the check again later" is the correct instruction for a caller
   * that did not re-query. The TRUE reason is not lost: `gatewayNote` and the audit row carry the
   * verdict's own `reason` field verbatim, so a reader reconstructing the run sees
   * `not_reconfirmed_now` rather than the staff line.
   */
  not_reconfirmed_now: 'skipped_e04111_too_recent',
}

const HOUR_MS = 60 * 60 * 1000
function hours(ms: number | null): number | null {
  return ms === null ? null : Math.round((ms / HOUR_MS) * 10) / 10
}

export type ClearHeldForReviewParams = {
  restaurantId: string
  /** The signed-in user this run is attributed to. Recorded on every audit row this run writes. */
  requestedBy?: string | null
  /** Test seam: override the Finatic call. Defaults to the real implementation. */
  queryFinaticOrderPaidFn?: typeof queryFinaticOrderPaid
  /** Test seam: override the clock used for the stranded-pending threshold. */
  nowMs?: number
  thresholdMs?: number
  /** Test seam / operator override: use this order as the venue's positive control. */
  controlOrderId?: string
}

/**
 * Ask about every held order at one venue and act on the answers.
 *
 * NEVER THROWS FOR A PER-ORDER FAILURE. It throws only when the held set itself cannot be read, at
 * which point there is nothing to report on. Everything after that point is per-order and lands in
 * the summary. See the header: an all-or-nothing run discards the answers it already has.
 */
export async function clearHeldForReview(
  supabase: Supabase,
  params: ClearHeldForReviewParams,
): Promise<ClearHeldSummary> {
  const {
    restaurantId,
    requestedBy = null,
    queryFinaticOrderPaidFn = queryFinaticOrderPaid,
    nowMs = Date.now(),
    thresholdMs = STRANDED_PENDING_THRESHOLD_MS,
    controlOrderId,
  } = params

  const startedAt = new Date().toISOString()
  const summary: ClearHeldSummary = {
    startedAt,
    finishedAt: startedAt,
    requestedBy,
    venues: [],
    outcomes: [],
    counts: emptyCounts(),
    cancelledIds: [],
    paidIds: [],
    heldForAmountReviewIds: [],
    unverifiableIds: [],
    skippedIds: [],
    gatewayAsks: 0,
    gatewayAsksFailed: 0,
    allGatewayCallsFailed: false,
  }

  const control: ClearHeldControl = {
    orderId: null,
    orderNumber: null,
    verdict: 'unavailable_no_candidate',
    asks: 0,
    markerless: false,
    lastGatewayCode: NOT_ASKED,
    note: null,
  }
  const venue: ClearHeldVenueResult = { restaurantId, control, orderIds: [] }
  summary.venues.push(venue)

  /**
   * Recording an outcome is the ONLY way an order leaves this function, and it always writes the
   * audit row for the non-money outcomes. A `continue` that forgot the audit insert is the omission
   * `cancelOrderWithTrail` exists to make unexpressible on the cancel path; this is the same idea on
   * the skip path.
   */
  const record = async (
    row: OrderRow,
    cause: string,
    outcome: ClearHeldOutcome,
    gateway: {
      code: string
      status?: string | null
      amount?: number | null
      askedAt?: string | null
      note?: string | null
      /**
       * Extra metadata for THIS order's audit row only. Carries the E04111 persistence verdict's
       * numbers on the four refusals: a reader must be able to see WHY it was refused — the age,
       * the observation count, the span — without re-deriving them from a sentence.
       */
      extra?: Record<string, unknown>
    },
  ) => {
    const orderId = String(row.id)
    const result: ClearHeldOrderResult = {
      orderId,
      restaurantId,
      // hasAllocatedOrderNumber, NOT `== null`. `0` and `''` are both real shapes in this column
      // and both mean "none allocated"; admitting them is how "Order #0" reached production three
      // times. scripts/check-order-number-guard.ts caught this exact line. See order-identity.ts.
      orderNumber: hasAllocatedOrderNumber(row) ? Number(row.order_number) : null,
      total: toNumber(row.total),
      channel: trimmed(row.channel) || '(none)',
      cause,
      outcome,
      gatewayCode: gateway.code,
      gatewayStatus: gateway.status ?? null,
      gatewayAmount: gateway.amount ?? null,
      gatewayAskedAt: gateway.askedAt ?? null,
      gatewayNote: gateway.note ?? null,
      controlVerdict: control.verdict,
      wrote: clearHeldOutcomeWrote(outcome),
    }
    summary.outcomes.push(result)
    summary.counts[outcome] += 1
    venue.orderIds.push(orderId)

    if (outcome === 'cancelled') summary.cancelledIds.push(orderId)
    else if (outcome === 'gateway_confirmed_paid') summary.paidIds.push(orderId)
    else if (outcome === 'gateway_paid_amount_disagrees') summary.heldForAmountReviewIds.push(orderId)
    else if (outcome === 'unverifiable_no_credentials' || outcome === 'unverifiable_no_gateway_reference')
      summary.unverifiableIds.push(orderId)
    else summary.skippedIds.push(orderId)

    // The money outcomes already wrote their own trail through the shared writers, which carry the
    // gateway code in their metadata. Writing a second row for them would double-count the run.
    if (result.wrote) return

    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: restaurantId,
      entity_type: 'order',
      entity_id: orderId,
      action: HELD_CLEAR_SKIPPED_ACTION,
      metadata: {
        source: 'held_for_review_clear_all',
        requestedBy,
        outcome,
        cause,
        orderTotal: result.total,
        businessOrderNo: trimmed(row.paycloud_merchant_order_no) || null,
        gatewayCode: result.gatewayCode,
        gatewayStatus: result.gatewayStatus,
        gatewayAskedAt: result.gatewayAskedAt,
        gatewayNote: result.gatewayNote,
        controlOrderId: control.orderId,
        controlVerdict: control.verdict,
        reason: CLEAR_HELD_OUTCOME_AUDIT_REASON[outcome],
        ...(gateway.extra ?? {}),
      },
    })
    // BEST-EFFORT, unlike the money writers. Losing this row loses an observation; it does not
    // change what happened to the order, because nothing happened to the order.
    if (error) {
      console.error(
        `[clearHeldForReview] skip audit insert failed for order ${orderId} (${outcome}):`,
        error,
      )
    }
  }

  const heldOrders = await readHeldOrders(supabase, restaurantId, thresholdMs, nowMs)

  // Classified through the SAME function the screen uses, so this action and the surface can never
  // disagree about what is held. An order the screen would not show is not one this button clears.
  const candidates = heldOrders
    .map((row) => ({ row, cause: heldForReviewCause(row as HeldForReviewCandidate, nowMs, thresholdMs) }))
    .filter((entry): entry is { row: OrderRow; cause: string } => entry.cause !== null)

  /**
   * THE TWO HOLD CAUSES NEVER REACH THE GATEWAY LOOP, and that is a decision rather than an
   * oversight.
   *
   * `amount_mismatch_hold` means a gateway has ALREADY confirmed a payment for that order and the
   * only thing unresolved is the figure. Asking again cannot change that, and cancelling it would
   * cancel a charged card — the exact outcome #223's quarantine exists to prevent.
   *
   * `verification_unavailable_hold` means the venue had no credentials when the cron reached it.
   * Nobody can verify it, so it takes the same name as a live credentials failure rather than a
   * second one that a reader would have to learn.
   *
   * Both are still NAMED, counted and audited. Handling them before the control is picked also
   * means a venue whose only held rows are these needs no control and makes no gateway call.
   */
  const strandedCandidates: Array<{ row: OrderRow; cause: string }> = []
  for (const entry of candidates) {
    if (entry.cause === STRANDED_PENDING_CAUSE) {
      strandedCandidates.push(entry)
      continue
    }
    if (entry.cause === AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS) {
      await record(entry.row, entry.cause, 'skipped_gateway_confirmed_payment_already_held', {
        code: NOT_ASKED,
        note: 'A gateway has already confirmed a payment for this order; only the amount is unresolved.',
      })
      continue
    }
    if (entry.cause === VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS) {
      await record(entry.row, entry.cause, 'unverifiable_no_credentials', {
        code: NOT_ASKED,
        note: 'Already held because the venue had no Finatic credentials when the sweep reached it.',
      })
      continue
    }
    /**
     * A CAUSE THIS FILE DOES NOT KNOW IS NEVER TREATED AS ACTIONABLE. `HELD_FOR_REVIEW_PAYMENT_STATUSES`
     * gains members over time — it went from one to two in the #153/#353 merge — and the surface is
     * built so a new member starts rendering without an edit. This must fail the OTHER way: an
     * unrecognised cause is reported unverifiable and left alone, never swept into the cancel path
     * by a change to a constant somewhere else. Same direction as my-orders' `🎉 New` bug, inverted.
     */
    await record(entry.row, entry.cause, 'unverifiable_no_credentials', {
      code: NOT_ASKED,
      note: `Held under a cause this action does not know how to resolve (${entry.cause}). Left untouched.`,
    })
  }

  if (strandedCandidates.length === 0) {
    control.note = 'No orders needed a gateway answer, so no control was formed and nothing was asked.'
    await writeControlAudit(supabase, restaurantId, control, requestedBy, summary)
    return finalise(summary)
  }

  const toProcess = strandedCandidates.slice(0, MAX_CLEARED_PER_RUN)
  for (const entry of strandedCandidates.slice(MAX_CLEARED_PER_RUN)) {
    await record(entry.row, entry.cause, 'deferred_run_cap', {
      code: NOT_ASKED,
      note: `Over the per-run ceiling of ${MAX_CLEARED_PER_RUN}. Untouched and still held.`,
    })
  }

  /**
   * CREDENTIALS FIRST, FOR THE VENUE, BEFORE ANY CONTROL OR ANY CANDIDATE.
   *
   * A venue with no credentials cannot form a control either, so asking about the control first
   * would report `control_unavailable` for a venue whose real answer is the permanent one. The
   * permanent condition must be the one that gets named.
   */
  let credentials: { merchantNo: string; storeNo: string }
  try {
    const resolved = await getRestaurantFinaticCredentials(restaurantId)
    credentials = { merchantNo: resolved.merchantNo, storeNo: resolved.storeNo }
  } catch (err) {
    const permanent = isMissingFinaticCredentialsError(err)
    control.verdict = permanent ? 'unavailable_no_credentials' : 'failed_gateway_error'
    control.lastGatewayCode = permanent ? 'NO_CREDENTIALS' : 'CREDENTIAL_READ_FAILED'
    control.note = permanent
      ? 'This venue has no Finatic merchant/store pair, so no gateway question can be formed for any order here.'
      : 'The credential read itself failed, so it is unknown whether this venue can be asked. Unknown never authorises a cancel.'
    for (const entry of toProcess) {
      await record(
        entry.row,
        entry.cause,
        permanent ? 'unverifiable_no_credentials' : 'skipped_gateway_unreachable',
        { code: control.lastGatewayCode, note: control.note },
      )
    }
    await writeControlAudit(supabase, restaurantId, control, requestedBy, summary)
    return finalise(summary)
  }

  // ---- the control ------------------------------------------------------------------------
  let controlRow: OrderRow | null = null
  if (controlOrderId) {
    const { data } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', controlOrderId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    const candidate = (data ?? null) as OrderRow | null
    if (
      candidate &&
      trimmed(candidate.payment_status).toLowerCase() === 'paid' &&
      trimmed(candidate.paycloud_merchant_order_no) !== ''
    ) {
      controlRow = candidate
      control.markerless =
        !trimmed(candidate.payment_reference) && !trimmed(candidate.payment_voucher_no)
    }
  } else {
    const picked = await pickControl(supabase, restaurantId)
    if (picked) {
      controlRow = picked.row
      control.markerless = picked.markerless
    }
  }

  if (!controlRow) {
    control.verdict = 'unavailable_no_candidate'
    control.note =
      'This venue has no order that is both paid and carrying a gateway reference, so there is ' +
      'nothing whose answer is known in advance. Without that, an unpaid answer and a broken ' +
      'query path are the same observation.'
    for (const entry of toProcess) {
      await record(entry.row, entry.cause, 'skipped_control_unavailable', {
        code: NOT_ASKED,
        note: control.note,
      })
    }
    await writeControlAudit(supabase, restaurantId, control, requestedBy, summary)
    return finalise(summary)
  }

  control.orderId = String(controlRow.id)
  control.orderNumber = hasAllocatedOrderNumber(controlRow) ? Number(controlRow.order_number) : null
  const controlMerchantOrderNo = trimmed(controlRow.paycloud_merchant_order_no)

  // ---- the per-order loop -----------------------------------------------------------------
  let venueAbandoned = false
  for (const entry of toProcess) {
    const row = entry.row
    const orderId = String(row.id)

    if (venueAbandoned) {
      await record(row, entry.cause, 'skipped_control_failed', {
        code: control.lastGatewayCode,
        note: control.note,
      })
      continue
    }

    /**
     * 1. THE LIVE POSITIVE CONTROL, RE-ASKED FOR THIS CANDIDATE, BEFORE ANYTHING ELSE.
     *
     * Once per venue would be cheaper and would be wrong: a gateway that goes down after the third
     * order would answer "error" for the remaining three with a control that passed minutes ago
     * still vouching for it. The manual sweep re-asked per candidate for exactly this reason and
     * this does the same.
     */
    const controlAnswer = await ask(queryFinaticOrderPaidFn, {
      merchantOrderNo: controlMerchantOrderNo,
      ...credentials,
    })
    control.asks += 1
    summary.gatewayAsks += 1
    control.lastGatewayCode = controlAnswer.code
    if (controlAnswer.kind !== 'answered') summary.gatewayAsksFailed += 1

    const controlPassed = controlAnswer.kind === 'answered' && controlAnswer.paid
    if (!controlPassed) {
      control.verdict =
        controlAnswer.kind === 'answered' ? 'failed_not_paid' : 'failed_gateway_error'
      control.note =
        `The control order came back ${controlAnswer.code} when it is known to be paid. ` +
        'The query path is not trustworthy in this run, so nothing further was written at this venue.'
      venueAbandoned = true
      await record(row, entry.cause, 'skipped_control_failed', {
        code: controlAnswer.code,
        note: control.note,
      })
      continue
    }
    control.verdict = 'passed'

    /**
     * 2. RE-READ THE ROW ITSELF. The enumeration above is already seconds old, and seconds is all a
     * terminal callback needs. A probe written minutes ago describes a world that has changed.
     */
    const { data: freshData, error: freshError } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', orderId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    if (freshError || !freshData) {
      await record(row, entry.cause, 'skipped_already_resolved', {
        code: NOT_ASKED,
        note: 'The order could not be re-read immediately before the write, so it was left alone.',
      })
      continue
    }
    const fresh = freshData as OrderRow
    const freshCause = heldForReviewCause(fresh as HeldForReviewCandidate, nowMs, thresholdMs)
    if (freshCause !== STRANDED_PENDING_CAUSE) {
      await record(fresh, entry.cause, 'skipped_already_resolved', {
        code: NOT_ASKED,
        note:
          `It moved to status=${trimmed(fresh.status) || '(none)'} / ` +
          `payment_status=${trimmed(fresh.payment_status) || '(none)'} since it was listed.`,
      })
      continue
    }

    const merchantOrderNo = trimmed(fresh.paycloud_merchant_order_no)
    if (!merchantOrderNo) {
      /**
       * NEVER CANCELLED HERE, and this is a deliberate divergence from the cron.
       *
       * `autoCancelStalePosOrders` cancels a POS order with no reference outright, on the sound
       * reasoning that prepare-payment never ran. That reasoning is CHANNEL-SPECIFIC. The held
       * surface spans every channel, and 11 of the 13 non-POS stale orders measured on 2026-08-27
       * carry no reference at all because they are pay-at-till orders that legitimately never had
       * one — several of them `ready`, `preparing` or `completed`, i.e. the food was made.
       * Importing the POS rule here would write off real debt. And the owner's rule is narrower
       * than the cron's anyway: cancel only what comes back UNPAID, and an order nothing can be
       * asked about never comes back anything.
       */
      await record(fresh, entry.cause, 'unverifiable_no_gateway_reference', {
        code: NOT_ASKED,
        note: 'No gateway reference was ever allocated, so there is nothing to ask the gateway about.',
      })
      continue
    }

    // 3. THE ORDER'S OWN ANSWER, NOW.
    const askedAt = new Date().toISOString()
    const answer = await ask(queryFinaticOrderPaidFn, { merchantOrderNo, ...credentials })
    summary.gatewayAsks += 1
    if (answer.kind !== 'answered') summary.gatewayAsksFailed += 1

    try {
      await applyGatewayAnswer({
        supabase,
        summary,
        control,
        record,
        row: fresh,
        cause: entry.cause,
        answer,
        askedAt,
        merchantOrderNo,
        restaurantId,
        requestedBy,
        nowMs,
      })
    } catch (writeErr) {
      /**
       * The shared writers throw when their AUDIT insert fails — deliberately, because a money
       * column moved with no record is the defect, not the fix. Catching it HERE, per order, is
       * what keeps that throw from abandoning the rest of the run. The order is named and the run
       * continues; #153's catch inside the cron does the same thing for the same reason.
       */
      console.error(`[clearHeldForReview] write failed for order ${orderId}:`, writeErr)
      await record(fresh, entry.cause, 'skipped_gateway_unreachable', {
        code: answer.code,
        status: answer.kind === 'answered' ? answer.status : null,
        askedAt,
        note:
          'The gateway answered but the write or its audit row failed, so this order was left ' +
          `exactly as it was: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      })
    }
  }

  await writeControlAudit(supabase, restaurantId, control, requestedBy, summary)
  return finalise(summary)
}

/**
 * The gateway's answer -> the one thing this action is allowed to do about it.
 *
 * Split out so the decision table is readable in one screen and so a test can assert each branch
 * without standing up the whole run.
 */
async function applyGatewayAnswer(ctx: {
  supabase: Supabase
  summary: ClearHeldSummary
  control: ClearHeldControl
  record: (
    row: OrderRow,
    cause: string,
    outcome: ClearHeldOutcome,
    gateway: {
      code: string
      status?: string | null
      amount?: number | null
      askedAt?: string | null
      note?: string | null
      extra?: Record<string, unknown>
    },
  ) => Promise<void>
  row: OrderRow
  cause: string
  answer: GatewayAnswer
  askedAt: string
  merchantOrderNo: string
  restaurantId: string
  requestedBy: string | null
  /**
   * The run's clock, threaded through so the E04111 age test is measured against the same instant
   * as everything else in the run and can be driven by the `nowMs` seam in a test. A run lasts
   * seconds; the ruling's unit is hours, so run-start and per-order are the same number.
   */
  nowMs: number
}): Promise<void> {
  const { supabase, control, record, row, cause, answer, askedAt, merchantOrderNo, restaurantId, requestedBy, nowMs } = ctx
  const orderId = String(row.id)
  const orderTotal = toNumber(row.total)

  if (answer.kind === 'no_credentials') {
    // Reachable even after the venue-level check: credentials are cached, and a cache expiry
    // mid-run puts the permanent condition back in front of us. Same name, same non-action.
    await record(row, cause, 'unverifiable_no_credentials', {
      code: answer.code,
      askedAt,
      note: 'The venue has no Finatic credentials, so this order cannot be verified by anyone.',
    })
    return
  }

  if (answer.kind === 'error') {
    await record(row, cause, 'skipped_gateway_unreachable', {
      code: answer.code,
      askedAt,
      note: `The gateway could not be asked about this order: ${answer.message}. Unreachable is not not-charged.`,
    })
    return
  }

  if (answer.kind === 'no_record') {
    /**
     * E04111 — "merchant order number is invalid", i.e. the gateway has no record of this
     * reference. THIS IS AN ERROR, NOT A NOT-PAID STATUS, and on its own it never authorises a
     * cancel: order #149 answered E04111 at 13:58:48 and was confirmed PAID on the same reference
     * 22 seconds later.
     *
     * WHAT MAKES IT ACTIONABLE HERE IS A CONJUNCTION:
     *   (a) the order carries NEITHER payment_reference NOR payment_voucher_no; AND
     *   (b) E04111 came back live, in this run; AND
     *   (c) the venue's positive control came back PAID in this same iteration; AND
     *   (d) THE PERSISTENCE RULING HOLDS — `e04111PersistenceAuthorisesCancel`.
     *
     * (a) alone would have cancelled N$201 of real charges at FNB ChowNow (#456, #500 and #546 are
     * paid and carry neither marker). (b) alone is the mass-cancel the 2026-08-05 removal
     * prevented. (c) is what separates "no record" from "the query path is broken".
     *
     * ============================================================================================
     * (d) IS THE OWNER'S RULING OF 2026-08-27 AND IT IS WHY THIS BRANCH IS NOT A ONE-LINER.
     * ============================================================================================
     *
     * Without it, (a)+(b)+(c) cancel an order whose card was presented ten minutes ago on the
     * strength of a single sample of a system that has been MEASURED changing its answer inside 22
     * seconds. #149 and this ruling bound each other, and the boundary is TIME: a single E04111 is
     * never terminal; an E04111 that has persisted for 72 hours, been seen at least twice at least
     * 24 hours apart, and been reconfirmed by a fresh query at the moment of the write, is.
     *
     * THE RULING IS NOT REIMPLEMENTED HERE. `e04111PersistenceAuthorisesCancel` is the single
     * implementation, with eleven two-sided tests of its own, and the thresholds live beside it. A
     * second copy of a money rule is a second rule the moment either one is edited.
     *
     * `reconfirmedNow: true` is passed as a LITERAL and it is honest: `answer` is the result of a
     * gateway call made in this run, on this reference, a few statements above, and this is the only
     * call site. The parameter exists precisely so a caller that has NOT re-queried cannot satisfy
     * condition 3 by leaving it out.
     */
    if (trimmed(row.payment_reference) || trimmed(row.payment_voucher_no)) {
      await record(row, cause, 'skipped_gateway_no_record_but_marker_present', {
        code: answer.code,
        askedAt,
        note:
          'The gateway has no record of this reference, yet the order carries a payment marker. ' +
          'Those two cannot both be simple, and a contradiction is not a licence to cancel.',
      })
      return
    }

    const observedAt = await readE04111Observations(supabase, restaurantId, merchantOrderNo)
    const verdict = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: row.payment_attempt_started_at,
      observedAt,
      reconfirmedNow: true,
      now: new Date(nowMs),
    })

    /**
     * THE NUMBERS THE VERDICT WAS REACHED ON, recorded on BOTH sides — the cancel and each refusal.
     *
     * A verdict with no numbers behind it is unauditable: "we decided it had persisted" is not a
     * measurement, and Rule 20 applies to an audit row as much as to a comment. Anyone
     * reconstructing this run must be able to see the age, the count and the span that were true at
     * the moment of the decision, plus the thresholds they were compared against — because the
     * thresholds can change and the row must still be readable afterwards.
     */
    const persistence = {
      rule: 'e04111_persistence_2026_08_27',
      reason: verdict.reason,
      authorisesCancel: verdict.authorisesCancel,
      attemptStartedAt: row.payment_attempt_started_at ?? null,
      ageMs: verdict.ageMs,
      ageHours: hours(verdict.ageMs),
      observationCount: verdict.observationCount,
      observationSpanMs: verdict.observationSpanMs,
      observationSpanHours: hours(verdict.observationSpanMs),
      thresholdMs: E04111_PERSISTENCE_CANCEL_MS,
      minObservationSeparationMs: E04111_MIN_OBSERVATION_SEPARATION_MS,
      observationsReadLimit: E04111_OBSERVATION_READ_LIMIT,
      reconfirmedNow: true,
      reconfirmedAt: askedAt,
    }

    /**
     * THE CANCEL IS THE NARROW BRANCH AND EVERYTHING ELSE REFUSES, written in that order on
     * purpose. Both halves of the verdict have to agree — `authorisesCancel` AND the one reason
     * that means it — so a future shape in which they disagree lands on the refusal side rather
     * than falling through to a write. On a money path the default must be "do nothing", and a
     * default is whatever happens when the condition is not exactly what you expected.
     */
    if (!(verdict.authorisesCancel && verdict.reason === 'persisted_beyond_threshold')) {
      /**
       * `persisted_beyond_threshold` with `authorisesCancel: false` is an incoherent verdict this
       * helper cannot produce. If one ever arrives, it is treated as "the fresh confirmation was
       * never established" — the strictest of the refusals — and the row still carries the verdict's
       * own `reason` verbatim, so nothing about it is hidden from a reader.
       */
      const refusalReason =
        verdict.reason === 'persisted_beyond_threshold' ? 'not_reconfirmed_now' : verdict.reason
      await record(row, cause, E04111_REFUSAL_OUTCOME[refusalReason], {
        code: answer.code,
        askedAt,
        note:
          `E04111 was reconfirmed live, but the persistence ruling refused the cancel: ` +
          `${verdict.reason}. Age ${hours(verdict.ageMs) ?? 'unknown'}h against a ${
            E04111_PERSISTENCE_CANCEL_MS / (60 * 60 * 1000)
          }h threshold; ${verdict.observationCount} recorded observation(s) spanning ${
            hours(verdict.observationSpanMs) ?? 'n/a'
          }h. Nothing was changed, and this is not evidence that no card was charged.`,
        extra: { e04111Persistence: persistence },
      })
      return
    }

    await cancel(ctx, 'e04111_no_attempt_reached_gateway', answer.code, askedAt, {
      gatewayMessage: answer.message,
      e04111Persistence: persistence,
      /**
       * SAID OUT LOUD, IN THE ROW, because the two authorisations are not the same evidence and a
       * reader must never have to infer which one fired. `finatic_verified_not_paid` means the
       * gateway told us it failed. THIS means the gateway said it has never heard of the reference,
       * for long enough, often enough, and again just now — a conclusion drawn from PERSISTENCE, not
       * from an answer. `queryFinaticOrderPaid` never returns `paid: false` for an E04111; the call
       * throws, so no `paid=false` answer was ever in evidence for this order.
       */
      authorisedBy: 'e04111_persistence_rule',
      authorisedByNote:
        'Cancelled on the E04111 PERSISTENCE ruling of 2026-08-27, NOT on a paid=false answer from ' +
        'the gateway. No such answer exists for this order: an E04111 query throws rather than ' +
        'returning not-paid. The evidence is that the reference has been unknown to the gateway ' +
        'for longer than the threshold, across separated observations, and was unknown again when ' +
        'asked in this run.',
    })
    return
  }

  // ---- answer.kind === 'answered' ----------------------------------------------------------
  if (answer.paid) {
    /**
     * #223 + #268. GATEWAY LEG, so GATEWAY_AMOUNT_TOLERANCE_CENTS (zero) and ABSENT-IS-NOT-AGREEING:
     * a confirmed payment that carried no amount was never amount-verified, and is quarantined for
     * the same reason a disagreeing figure is. Marking it paid on the ORDER's total would write a
     * figure the gateway never said.
     */
    const gatewayAmount = answer.amount
    const agrees =
      gatewayAmount !== null && amountsMatch(gatewayAmount, orderTotal, GATEWAY_AMOUNT_TOLERANCE_CENTS)

    if (!agrees) {
      const held = await holdForAmountReview(supabase, {
        orderId,
        restaurantId,
        merchantOrderNo,
        gatewayAmount,
        orderTotal,
        transactionId: answer.transactionId,
        source: 'held_for_review_clear_all',
      })
      await record(row, cause, held ? 'gateway_paid_amount_disagrees' : 'skipped_already_resolved', {
        code: answer.code,
        status: answer.status,
        amount: gatewayAmount,
        askedAt,
        note: held
          ? 'The gateway confirmed a payment whose amount does not agree with the order total. Neither paid nor cancelled.'
          : 'Something else resolved this order between the gateway answer and the write.',
      })
      return
    }

    const claim = await markOrderPaidConfirmed(supabase, {
      orderId,
      restaurantId,
      reference: merchantOrderNo,
      voucherNo: answer.transactionId || merchantOrderNo,
      amount: gatewayAmount,
      gatewayAmount,
      source: 'held_for_review_clear_all',
      extraAuditMetadata: {
        correctionReason:
          'A person cleared this order from the Held for review surface. The gateway was asked ' +
          'again in that same run and confirmed a successful payment, so the order was corrected ' +
          'to paid instead of cancelled.',
        requestedBy,
        gatewayCode: answer.code,
        gatewayStatus: answer.status,
        gatewayAskedAt: askedAt,
        gatewayAmount,
        orderTotal,
        amountVerified: true,
        positiveControl: {
          orderId: control.orderId,
          orderNumber: control.orderNumber,
          verdict: control.verdict,
          markerless: control.markerless,
        },
      },
      fromPaymentStatuses: ['pending'],
    })
    await record(row, cause, claim.claimed ? 'gateway_confirmed_paid' : 'skipped_already_resolved', {
      code: answer.code,
      status: answer.status,
      amount: gatewayAmount,
      askedAt,
      note: claim.claimed
        ? 'The gateway confirmed this payment. Surfaced as paid, never cancelled.'
        : 'Something else resolved this order between the gateway answer and the write.',
    })
    return
  }

  if (!answer.statusRecognised) {
    /**
     * UNKNOWN NEVER AUTHORISES A CANCEL. `paid` is a boolean, so without this branch every value
     * the gateway has never returned to us collapses into "not paid" and cancels a real customer's
     * order on a card that may have cleared. Nobody has the enum: across 43 live order.query calls
     * spanning three restaurants and four weeks only 1 and 2 were ever observed, and no vendor
     * documentation of trans_status exists.
     */
    await record(row, cause, 'skipped_gateway_status_unrecognised', {
      code: answer.code,
      status: answer.status,
      amount: answer.amount,
      askedAt,
      note:
        `The gateway answered with a status this codebase does not recognise (${answer.status}). ` +
        'Recorded verbatim so the value is findable here rather than in a cancelled order.',
    })
    return
  }

  await cancel(ctx, 'finatic_verified_not_paid', answer.code, askedAt, {
    gatewayStatus: answer.status,
    gatewayAmount: answer.amount,
  })
}

/** The one write that cancels, with the control's identity in the trail. */
async function cancel(
  ctx: Parameters<typeof applyGatewayAnswer>[0],
  basis: CancelBasis,
  gatewayCode: string,
  askedAt: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const { supabase, control, record, row, cause, restaurantId, requestedBy, merchantOrderNo } = ctx
  const result = await cancelOrderWithTrail(supabase, {
    orderId: String(row.id),
    restaurantId,
    /**
     * NOT 'auto_timeout'. That string is read by `isCancelledOnE04111Evidence` as a NON-recoverable
     * prefix, so writing it here would silently make these orders unrecoverable if a charge is
     * later found — a money-path change nobody has ruled. This reason matches no enumerated
     * non-recoverable prefix, which leaves the order RECOVERABLE by the PayCloud webhook, and the
     * last sentence says so out loud for whoever reads the row.
     */
    cancellationReason:
      'Cleared from the Held for review surface by a person. The gateway was re-queried for this ' +
      `order in that same run and answered ${gatewayCode}, alongside a live positive control at ` +
      'the same venue that came back PAID. If a charge is later found, this order must be treated ' +
      'as recoverable.',
    basis,
    // A terminal callback that settles the order a millisecond earlier WINS and this writes nothing.
    guard: 'require_pending',
    metadata: {
      source: 'held_for_review_clear_all',
      requestedBy,
      cause,
      gatewayCode,
      gatewayAskedAt: askedAt,
      businessOrderNo: merchantOrderNo,
      markersAtCancel: {
        payment_reference: row.payment_reference ?? null,
        payment_voucher_no: row.payment_voucher_no ?? null,
      },
      positiveControl: {
        orderId: control.orderId,
        orderNumber: control.orderNumber,
        verdict: control.verdict,
        markerless: control.markerless,
        note: 'Re-queried live in this same iteration; a failing control abandons the venue untouched.',
      },
      ...extra,
    },
  })
  await record(row, cause, result.cancelled ? 'cancelled' : 'skipped_already_resolved', {
    code: gatewayCode,
    askedAt,
    note: result.cancelled
      ? null
      : 'Lost the concurrency guard — something settled this order between the answer and the write.',
  })
}

/**
 * ONE ROW PER VENUE PER RUN, ALWAYS, INCLUDING THE RUNS THAT WROTE NOTHING.
 *
 * See HELD_CLEAR_CONTROL_ACTION: a run aborted by a failing control writes nothing else at all, so
 * without this row it is indistinguishable in the database from a run that never happened. That is
 * the same false negative the control itself exists to prevent, one layer out.
 */
async function writeControlAudit(
  supabase: Supabase,
  restaurantId: string,
  control: ClearHeldControl,
  requestedBy: string | null,
  summary: ClearHeldSummary,
): Promise<void> {
  const { error } = await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    entity_type: 'order',
    // The CONTROL order is the entity, when there is one. A run with no control is still recorded,
    // keyed to the restaurant with a null entity, rather than not recorded.
    entity_id: control.orderId,
    action: HELD_CLEAR_CONTROL_ACTION,
    metadata: {
      source: 'held_for_review_clear_all',
      requestedBy,
      controlOrderId: control.orderId,
      controlOrderNumber: control.orderNumber,
      controlMarkerless: control.markerless,
      verdict: control.verdict,
      asks: control.asks,
      lastGatewayCode: control.lastGatewayCode,
      note: control.note,
      gatewayAsks: summary.gatewayAsks,
      gatewayAsksFailed: summary.gatewayAsksFailed,
      ordersConsidered: summary.outcomes.length,
      reason:
        'A known-paid order at this venue, on the same credentials, re-queried live in the same ' +
        'run as every decision it stands behind. Only a PAID verdict permits a write. Without it, ' +
        '"every order is unpaid" and "the gateway is down" are the same observation.',
    },
  })
  if (error) {
    console.error('[clearHeldForReview] control audit insert failed:', error)
  }
}

function finalise(summary: ClearHeldSummary): ClearHeldSummary {
  summary.finishedAt = new Date().toISOString()
  summary.allGatewayCallsFailed =
    summary.gatewayAsks > 0 && summary.gatewayAsksFailed === summary.gatewayAsks
  return summary
}

/**
 * The sentence written into each skip's audit row. NOT staff-facing copy — these land in
 * `audit_logs.metadata` and are read by whoever is reconstructing what a run did, the same role
 * `CANCEL_BASIS_NOTE` plays for cancels. The staff-facing wording for the same outcomes lives in
 * `CLEAR_HELD_OUTCOME_COPY` and carries the PENDING COPY marker until the owner signs it.
 */
export const CLEAR_HELD_OUTCOME_AUDIT_REASON: Record<ClearHeldOutcome, string> = {
  cancelled:
    'Cancelled on a live gateway answer taken in the same run, behind a passing positive control.',
  gateway_confirmed_paid:
    'The gateway confirmed a payment agreeing with the order total. Corrected to paid, not cancelled.',
  gateway_paid_amount_disagrees:
    'The gateway confirmed a payment whose amount does not agree with the order total, or carried ' +
    'no amount at all. ABSENT IS NOT AGREEING. Neither paid nor cancelled; quarantined for a human.',
  unverifiable_no_credentials:
    'The venue has no Finatic merchant/store pair, so this order cannot be verified by this action, ' +
    'by the cron, or by a person. NOT cancelled: an absent credential is not evidence that no card ' +
    'was charged — the device-side flow charges under the reader\'s own merchant, which is not ' +
    'recorded here. Left held.',
  unverifiable_no_gateway_reference:
    'No paycloud_merchant_order_no was ever allocated, so the gateway has nothing to be asked ' +
    'about. Deliberately NOT cancelled here, unlike the POS cron: this surface spans channels ' +
    'whose orders legitimately never had a reference and where real debt is still owed.',
  skipped_gateway_unreachable:
    'The gateway could not be asked, or the write that followed failed. Unreachable is not ' +
    'not-charged; the order is unchanged and will still be on the surface.',
  skipped_gateway_no_record_but_marker_present:
    'The gateway has no record of this reference (E04111) and yet the order carries a payment ' +
    'marker. E04111 alone is never terminal, and with a marker present the two facts contradict ' +
    'each other. A contradiction is not a licence to cancel.',
  skipped_e04111_too_recent:
    'E04111 was reconfirmed live, but under 72h have passed since payment_attempt_started_at. ' +
    'Order #149 answered E04111 and was confirmed PAID on the same reference 22 seconds later, so ' +
    'a recent E04111 is a race in progress, not a verdict. Left held; it will be reconsidered.',
  skipped_e04111_insufficient_observations:
    'E04111 was reconfirmed live and the order is old enough, but fewer than two E04111 ' +
    'observations are recorded for this reference. One sample of a system measured changing its ' +
    'answer is not evidence of a settled state. Left held.',
  skipped_e04111_observations_too_close_together:
    'Two or more E04111 observations exist for this reference but they span less than 24h, so they ' +
    'describe one moment rather than a persistent condition. Left held.',
  skipped_e04111_no_attempt_timestamp:
    'The order carries no usable payment_attempt_started_at, so there is no clock to measure the ' +
    'gateway race on. REFUSED rather than falling back to placed_at, which can predate the card ' +
    'being presented by days. This one does not resolve by waiting and needs a person.',
  skipped_gateway_status_unrecognised:
    'The gateway answered with a trans_status this codebase does not recognise. Unknown is not ' +
    'not-paid, and unknown never authorises a cancel. The value is recorded verbatim.',
  skipped_gateway_confirmed_payment_already_held:
    'This order is at amount_mismatch_hold: a gateway has ALREADY confirmed a payment for it and ' +
    'only the figure is unresolved. Cancelling it would cancel a charged card.',
  skipped_already_resolved:
    'The order left the held set between being listed and being written to — settled, cancelled or ' +
    'moved by something else. The concurrency guard held and nothing was overwritten.',
  skipped_control_failed:
    'The venue\'s live positive control did not come back PAID, so no gateway answer in this run ' +
    'can be trusted and nothing further was written at this venue.',
  skipped_control_unavailable:
    'No order at this venue is both paid and carrying a gateway reference, so no positive control ' +
    'could be formed. Without one, an unpaid answer and a broken query path are the same observation.',
  deferred_run_cap:
    `More than ${MAX_CLEARED_PER_RUN} orders were held at this venue. The remainder were not ` +
    'touched and are still on the surface for the next run.',
}
