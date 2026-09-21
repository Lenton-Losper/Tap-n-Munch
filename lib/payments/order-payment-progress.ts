/**
 * HOW MUCH OF AN ORDER HAS BEEN PAID FOR, AS A THING A HUMAN CAN READ.
 *
 * ==================================================================================================
 * DISPLAY ONLY. THIS DECIDES NOTHING.
 * ==================================================================================================
 *
 * Nothing here settles, claims, charges, refunds or writes. It takes rows that have ALREADY been
 * read by the authoritative readers and reduces them to a label and a figure. If this module
 * returned nonsense, no money would move differently -- a waiter would merely be told something
 * untrue, which is the bug it exists to fix rather than one it can cause.
 *
 * `chargeableCentsFor` in lib/payments/settled-cents.ts remains the ONLY thing that decides what a
 * card may be asked for. This deliberately does not import it, because the two answer different
 * questions: that one fails closed and refuses rather than under-charge, this one degrades to the
 * least-committal label rather than refuse to render a page.
 *
 * ==================================================================================================
 * WHY THE ORDER'S OWN STATUS OUTRANKS THE ARITHMETIC
 * ==================================================================================================
 *
 * An order settled whole -- the ordinary case, and every order placed before item-splitting
 * existed -- carries NO allocations at all. Summing its allocations gives zero settled, which read
 * naively says "nothing paid" about an order that is fully paid. So `paymentStatus === 'paid'` wins
 * outright and the arithmetic is only consulted below it.
 *
 * This is the same precedence `payableLines` uses on the terminal
 * (src/lib/takePaymentLines.ts: "The order's own status is the authority on paid, not the
 * allocation arithmetic"). The two are deliberately the same rule stated twice, in two codebases
 * that cannot import from each other; if one ever changes, the other is wrong.
 *
 * ==================================================================================================
 * AN UNPRICED LINE IS NOT A FREE LINE
 * ==================================================================================================
 *
 * A line the server could not price (`totalCents === null`) is counted in the DENOMINATOR and never
 * in the numerator. "3/4 paid" where the fourth is unpriceable is honest; calling it 4/4 because an
 * unknown is not an outstanding number would tell a waiter the table is settled when nobody knows
 * what the last item costs.
 */

/** The three states a reader needs to tell apart. `partial` is the one that used to say PENDING. */
export type OrderPaymentState = 'unpaid' | 'partial' | 'paid'

/** Just enough of a line to say whether it has been paid for. Both figures in integer cents. */
export type ProgressLine = {
  /** The line's own money, or null when the server could not price it. */
  totalCents: number | null
  /** Cents already settled against this line through settled, non-voided allocations. */
  settledCents: number
}

export type OrderPaymentProgress = {
  state: OrderPaymentState
  /** Lines fully paid for. Never counts an unpriced line. */
  paidLines: number
  /** Every line on the order, including unpriced ones. */
  totalLines: number
  /** Still to collect, in integer cents. Zero when paid. */
  remainingCents: number
  /** Collected so far, in integer cents. */
  paidCents: number
}

const toCents = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

const nonNegativeInt = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

/**
 * Reduce one order to a payment-progress summary.
 *
 * `orderTotal` is in MAJOR UNITS (what `orders.total` holds); every other figure here is cents.
 * The conversion happens once, at the boundary, for the reason
 * lib/payments/settlement-amount's summing note gives: adding major-unit figures accumulates float
 * error, and a bill that renders as N$6.000000000000001 is a bug report.
 */
export function orderPaymentProgress(params: {
  orderTotal: unknown
  paymentStatus: unknown
  lines: readonly ProgressLine[] | null | undefined
}): OrderPaymentProgress {
  const totalCents = Math.max(0, toCents(params.orderTotal))
  const status = String(params.paymentStatus ?? '').toLowerCase()
  const lines = Array.isArray(params.lines) ? params.lines : []
  const totalLines = lines.length

  // ---- the order's own status wins, in both directions ---------------------------------------
  if (status === 'paid') {
    return {
      state: 'paid',
      paidLines: totalLines,
      totalLines,
      remainingCents: 0,
      paidCents: totalCents,
    }
  }

  /**
   * NO LINE DATA IS NOT EVIDENCE OF PAYMENT. An order whose lines could not be read, or one that
   * predates line tracking, is reported UNPAID owing its whole total -- the same direction
   * `outstandingCentsForOrder` takes when it has no lines, and for the same reason: the failure
   * that says "nothing owed" is the one that loses money.
   */
  if (totalLines === 0) {
    return {
      state: totalCents === 0 ? 'paid' : 'unpaid',
      paidLines: 0,
      totalLines: 0,
      remainingCents: totalCents,
      paidCents: 0,
    }
  }

  let paidLines = 0
  let settledCents = 0
  for (const line of lines) {
    const settled = nonNegativeInt(line?.settledCents)
    settledCents += settled
    const lineTotal = line?.totalCents
    // An unpriced line can never be counted paid -- see the header.
    if (typeof lineTotal === 'number' && Number.isFinite(lineTotal) && lineTotal > 0 && settled >= lineTotal) {
      paidLines += 1
    }
  }

  /**
   * CLAMPED TO THE ORDER'S OWN TOTAL, both ways. The line figures and the order total are two
   * records of the same money. If the lines ever summed higher, `remainingCents` would go negative
   * and render as a credit the venue does not owe; if they summed lower than what was collected,
   * the order would appear to still owe money it has been paid.
   */
  const paidCents = Math.min(totalCents, settledCents)
  const remainingCents = Math.max(0, totalCents - paidCents)

  /**
   * THE LABEL FOLLOWS THE MONEY, NOT THE COUNT. A line count can read 4/4 while cents remain --
   * a partially settled allocation on a line whose shares do not add up yet is exactly that shape.
   * Calling that PAID would be the same ambiguity this change removes, one level down.
   */
  const state: OrderPaymentState =
    remainingCents === 0 ? 'paid' : paidCents > 0 || paidLines > 0 ? 'partial' : 'unpaid'

  return { state, paidLines, totalLines, remainingCents, paidCents }
}

/**
 * The one-line label a waiter reads, e.g. `3/4 PAID`, `UNPAID`, `PAID`.
 *
 * Kept next to the derivation rather than in a component so the terminal and the web can be held to
 * the same words, and so a test can pin the string without rendering anything.
 */
export function orderPaymentLabel(progress: OrderPaymentProgress): string {
  if (progress.state === 'paid') return 'PAID'
  if (progress.state === 'unpaid') return 'UNPAID'
  // A partial order with no line breakdown still has to say something true.
  if (progress.totalLines === 0) return 'PART PAID'
  return `${progress.paidLines}/${progress.totalLines} PAID`
}
