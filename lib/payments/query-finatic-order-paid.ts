import { queryPaymentOrder } from '@/payments/paycloud'

export type FinaticOrderPaidResult = {
  paid: boolean
  /**
   * Whether the gateway's status was a value we know how to read.
   *
   * `paid: false` alone cannot distinguish "the gateway told us it failed" from "the gateway said
   * something we have never seen". A caller that CANCELS on not-paid must check this first --
   * unknown never authorises a cancel. See the note at the assignment site.
   */
  statusRecognised: boolean
  merchantOrderNo: string
  status: string
  transactionId: string | null
  amount: number | null
  raw: Record<string, unknown>
}

/**
 * Finatic answered "no record of this merchant_order_no" (gateway code E04111).
 *
 * `queryPaymentOrder` throws a `PaycloudRequestError` with `phase: 'business'` for any
 * non-success `body.code`, so without this check E04111 is indistinguishable from a
 * network timeout at every catch site.
 *
 * IMPORTANT: this is NOT proof that no payment exists. E04111 is time-dependent, and the
 * evidence is IN THE DATABASE rather than in a document -- order #149 at Mingle
 * (paycloud_merchant_order_no FT17857583233613303, 2026-08-03) has:
 *
 *     11:58:48  payment.verification_uncertain
 *     11:59:10  payment.completed          <- 22 seconds later, same reference
 *
 * Re-verified against production audit_logs 2026-08-24. It means "not registered at the
 * gateway *yet*". A single observation is never a terminal answer.
 *
 * #260: this used to cite docs/finatic-questions-for-vernon.md, which EXISTS ON NO BRANCH and
 * never has (`git log --all` returns nothing). The claim was sound; its citation was not. Cite
 * the audit rows -- they can be re-queried, and a document that was never written cannot.
 */
export function isFinaticMerchantOrderInvalidError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    message?: unknown
    responseBody?: { code?: unknown; msg?: unknown } | null
  }
  const code = String(candidate.responseBody?.code ?? '').toUpperCase()
  const message = String(candidate.message ?? '').toUpperCase()
  return code === 'E04111' || message.includes('E04111')
}

/**
 * ============================================================================================
 * THE PERSISTENCE RULING. Owner ruling, 2026-08-27.
 * ============================================================================================
 *
 * READ THIS TOGETHER WITH THE BLOCK ABOVE. There are two rules about E04111 and they do not
 * contradict each other; each bounds the other, and the boundary is TIME.
 *
 *   ABOVE  a single E04111 observation is never a terminal answer, so it can never authorise a
 *          cancel. Order #149 flipped from verification_uncertain to completed on the SAME
 *          reference in 22 seconds.
 *   HERE   an E04111 that has PERSISTED for 72 hours or more, seen at least twice at least 24
 *          hours apart, and confirmed by a fresh query at the moment of the write, DOES
 *          authorise a cancel.
 *
 * WHY BOTH ARE TRUE. "Not registered at the gateway YET" is a statement about a race between our
 * write and theirs. #149 bounds how long that race can plausibly run: 22 seconds. Three days is
 * four orders of magnitude beyond it. A reference the gateway has never heard of after 72 hours is
 * not still settling -- it is a reference that was minted here and never presented there, which is
 * exactly what happens when staff ring an order up and the customer walks away.
 *
 * WHY 72 HOURS AND NOT "OLD ENOUGH". The threshold has to be a number in the code, because the
 * alternative is an operator deciding case by case what counts as old -- and six of these were
 * cleared by hand on 2026-08-27 precisely because no rule existed and they had sat for 14 days.
 * The next six would have waited too. 72h preserves #149's case entirely and by an enormous
 * margin.
 *
 * THE THREE CONDITIONS ARE CONJUNCTIVE AND EACH ONE CARRIES ITS OWN WEIGHT:
 *
 *   1. AGE IS MEASURED FROM THE PAYMENT ATTEMPT (`orders.payment_attempt_started_at`), never
 *      from `now()` minus a guess and never from `placed_at`. The attempt is the moment the
 *      reference was handed to the reader; that is the clock the gateway's race runs on. An order
 *      placed a week ago whose card was presented ten minutes ago is TEN MINUTES old for this
 *      purpose, and must not be cancelled.
 *
 *   2. TWO OBSERVATIONS AT LEAST 24 HOURS APART. One observation, however old the order, is a
 *      single sample of a system that has been shown to change its answer. Two separated by a day
 *      is evidence of a settled state rather than a moment. This is CHEAP to require because
 *      `payment.verification_uncertain` audit rows already carry `isE04111` and `businessOrderNo`
 *      -- measured 2026-08-27, the six live cases carried 103 to 106 observations each, spanning
 *      14 days. Requiring two costs nothing and rules out a class of mistake entirely.
 *
 *   3. A FRESH QUERY AT THE MOMENT OF THE WRITE. Never a verdict read from an earlier sweep. The
 *      caller must re-query in the same run as the cancel; a probe written minutes ago describes a
 *      world that has since moved, and this codebase has already shipped a verification that
 *      measured inside an async window and reported a state that was true for 80 seconds.
 *
 * WHAT THIS IS NOT. It is NOT `paid === false`. `queryFinaticOrderPaid` never returns for an
 * E04111 -- the call THROWS -- so a caller branching on `paid === false` will never reach this
 * rule, and a caller that treats a thrown E04111 as "not paid" is cancelling on an answer that
 * means "I have never heard of this reference". That is the third state, and it is the whole
 * reason this function exists rather than a boolean.
 */
export const E04111_PERSISTENCE_CANCEL_MS = 72 * 60 * 60 * 1000
export const E04111_MIN_OBSERVATION_SEPARATION_MS = 24 * 60 * 60 * 1000

export type E04111PersistenceVerdict = {
  /** True ONLY when every condition holds. Anything else, including uncertainty, is false. */
  authorisesCancel: boolean
  /** Machine-readable reason, recorded on the audit row. */
  reason:
    | 'persisted_beyond_threshold'
    | 'too_recent'
    | 'insufficient_observations'
    | 'observations_too_close_together'
    | 'no_attempt_timestamp'
    | 'not_reconfirmed_now'
  /** Milliseconds from the payment attempt to now. Recorded on the audit row. */
  ageMs: number | null
  observationCount: number
  observationSpanMs: number | null
}

/**
 * Decide whether a persistent E04111 authorises cancelling this order.
 *
 * Deliberately PURE and deliberately separate from the query: the decision is a ruling and has to
 * be testable without a gateway, and the caller has to be able to record exactly why it fired.
 *
 * `reconfirmedNow` is the caller's assertion that it has just re-queried and got E04111 again, in
 * this run. It is a parameter rather than something inferred, so that a caller which has NOT
 * re-queried cannot accidentally satisfy condition 3 by omission.
 */
export function e04111PersistenceAuthorisesCancel(params: {
  attemptStartedAt: string | Date | null | undefined
  /** Timestamps of previously RECORDED E04111 observations for this reference. */
  observedAt: Array<string | Date>
  reconfirmedNow: boolean
  now: Date
}): E04111PersistenceVerdict {
  const { attemptStartedAt, observedAt, reconfirmedNow, now } = params

  const attempt = attemptStartedAt ? new Date(attemptStartedAt) : null
  if (!attempt || Number.isNaN(attempt.getTime())) {
    // No attempt timestamp means no clock to measure the race on. Refuse -- do not fall back to
    // placed_at, which can predate the card being presented by days.
    return {
      authorisesCancel: false,
      reason: 'no_attempt_timestamp',
      ageMs: null,
      observationCount: observedAt.length,
      observationSpanMs: null,
    }
  }

  const ageMs = now.getTime() - attempt.getTime()
  const times = observedAt
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
  const observationSpanMs = times.length >= 2 ? times[times.length - 1] - times[0] : null

  const base = {
    ageMs,
    observationCount: times.length,
    observationSpanMs,
  }

  // Condition 3 first: without a fresh confirmation nothing else matters, and checking it first
  // means the reason recorded is the one a reader can act on.
  if (!reconfirmedNow) return { ...base, authorisesCancel: false, reason: 'not_reconfirmed_now' }
  if (ageMs < E04111_PERSISTENCE_CANCEL_MS) {
    return { ...base, authorisesCancel: false, reason: 'too_recent' }
  }
  if (times.length < 2) {
    return { ...base, authorisesCancel: false, reason: 'insufficient_observations' }
  }
  if ((observationSpanMs ?? 0) < E04111_MIN_OBSERVATION_SEPARATION_MS) {
    return { ...base, authorisesCancel: false, reason: 'observations_too_close_together' }
  }
  return { ...base, authorisesCancel: true, reason: 'persisted_beyond_threshold' }
}

/** Structural gateway code off a thrown PaycloudRequestError, for logs and audits. */
export function finaticErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as { responseBody?: unknown }).responseBody
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const code = (body as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase()
    if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  }
  return null
}

function toMoney(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

function parseOrderData(raw: Record<string, unknown>): Record<string, unknown> | null {
  let orderData: unknown = raw.data
  if (typeof orderData === 'string') {
    try {
      orderData = JSON.parse(orderData)
    } catch {
      return null
    }
  }
  if (orderData && typeof orderData === 'object' && !Array.isArray(orderData)) {
    return orderData as Record<string, unknown>
  }
  return null
}

/**
 * Query Finatic order.query and interpret paid / not-paid.
 * Shared by staff reconcile and terminal verify-payment.
 */
export async function queryFinaticOrderPaid(params: {
  merchantOrderNo: string
  merchantNo: string
  storeNo: string
}): Promise<FinaticOrderPaidResult> {
  const merchantOrderNo = params.merchantOrderNo.trim()
  const query = await queryPaymentOrder({
    orderId: merchantOrderNo,
    merchantNo: params.merchantNo,
    storeNo: params.storeNo,
  })
  const raw = (query.rawResponse || {}) as Record<string, unknown>
  const orderData = parseOrderData(raw)

  const transStatus = orderData?.trans_status ?? raw.trans_status
  const tradeOrStatus = String(
    orderData?.trade_status ?? orderData?.status ?? raw.trade_status ?? raw.status ?? '',
  ).toLowerCase()

  const paid =
    transStatus === 2 ||
    transStatus === '2' ||
    ['paid', 'success', 'succeeded'].includes(tradeOrStatus)

  /**
   * IS THIS A STATUS WE ACTUALLY RECOGNISE? Ruled 2026-08-22.
   *
   * `paid` is a boolean, so every value the gateway could ever return collapses into "not paid".
   * That is not safe in both directions: auto-cancel-stale-pos-orders.ts cancels an order outright
   * on `paid === false`, so a status nobody has ever seen would CANCEL A REAL CUSTOMER ORDER on a
   * card that may have cleared.
   *
   * NOBODY HAS THE ENUM. Measured 2026-08-21: no vendor documentation of `trans_status` exists on
   * either drive -- not in the Wise SDK javadocs (those are the on-device SDK, a different
   * surface), not in this repo, and the PayCloud REST reference directories are tracked but empty.
   * Across 43 live order.query calls spanning three restaurants and four weeks, exactly two values
   * were ever observed: 2 (paid, money fields populated) and 1 (failed, paid_amount "0", carrying
   * a trans_error_code). Everything else is unknown territory.
   *
   * So this reports whether the status was one we know how to read. `paid` keeps its exact meaning
   * -- this is additive, and no existing caller changes behaviour unless it opts in.
   *
   * Same asymmetry as the 2026-08-05 E04111 ruling: UNKNOWN NEVER AUTHORISES A CANCEL.
   */
  const RECOGNISED_PAID = [2, '2']
  const RECOGNISED_NOT_PAID = [1, '1']
  const RECOGNISED_TRADE_STATUS = ['paid', 'success', 'succeeded', 'failed', 'fail', 'closed']
  const statusRecognised =
    RECOGNISED_PAID.includes(transStatus as never) ||
    RECOGNISED_NOT_PAID.includes(transStatus as never) ||
    RECOGNISED_TRADE_STATUS.includes(tradeOrStatus)

  const statusText =
    tradeOrStatus ||
    (transStatus != null && String(transStatus).trim() ? String(transStatus) : 'unknown')

  const transactionId =
    String(
      orderData?.transactionID ??
        orderData?.transaction_id ??
        raw.psn ??
        raw.transaction_id ??
        '',
    ).trim() || null

  /**
   * paid_amount FIRST, and that ordering is the whole fix. Ruled 2026-08-22.
   *
   * This used to read `amount ?? order_amount ?? paid_amount`. Measured 2026-08-21: real
   * order.query responses carry NO `amount` key at all, so `order_amount` always won and
   * `paid_amount` was never reached.
   *
   * `order_amount` IS THE FIGURE WE SENT, echoed back. So every amountsMatch() gate downstream --
   * 24 call sites -- was comparing our own number against our own number. A gate that cannot fail.
   * On a real failed row (#563, N$25) the old expression extracted 25 from a transaction whose
   * paid_amount was "0".
   *
   * `paid_amount` is what the gateway says it actually took, which is what an amount gate is for.
   * Latent until now only because paid_amount == order_amount on all 13 paid rows measured; a tip,
   * a partial capture or an FX difference separates them and the gate silently passes the wrong
   * figure. order_amount is kept as a fallback for a response shape that omits paid_amount.
   */
  const amount = toMoney(
    orderData?.paid_amount ??
      orderData?.amount ??
      orderData?.order_amount ??
      raw.paid_amount ??
      raw.amount ??
      raw.order_amount,
  )

  return {
    paid,
    statusRecognised,
    merchantOrderNo,
    status: statusText,
    transactionId,
    amount,
    raw,
  }
}
