/**
 * RECONCILIATION: where did the money go, and what proves it?
 *
 * ==================================================================================================
 * THE TWO QUESTIONS THIS EXISTS TO ANSWER
 * ==================================================================================================
 *
 *   "For every Finatic transaction, where did this money go?"
 *   "For every FlashTap card payment, what gateway transaction proves it?"
 *
 * Neither was answerable before. The evidence is spread across four tables that nothing joined:
 *
 *   orders                     paid / not, method, paycloud_merchant_order_no, total
 *   payment_events             the ledger -- when the device managed to write one
 *   audit_logs                 payment.verification_uncertain, payment.amount_mismatch
 *   order_line_allocation_...  part-order settlements, which never appear in `orders.total` terms
 *
 * ==================================================================================================
 * IT REPORTS. IT DOES NOT RESOLVE.
 * ==================================================================================================
 *
 * Nothing here writes. That is the F11 ruling restated: an E04111 from this gateway means NO
 * RECORD, never NOT PAID, so auto-settling an uncertain payment is a free meal and auto-failing it
 * takes a real charge twice. The 2026-09-06 ruling that no sweeper may resolve an uncertain intent
 * is untouched and this module is deliberately incapable of breaking it -- it has no writer.
 *
 * What it does is make every anomaly FINDABLE, with the numbers that decide it attached, so a human
 * can act on a list instead of a suspicion.
 *
 * ==================================================================================================
 * ANOMALIES ARE NEVER HIDDEN
 * ==================================================================================================
 *
 * A row this module cannot classify is `unknown`, and `unknown` is a category that appears in the
 * output -- not a row that gets dropped. A reconciliation that quietly discards what it does not
 * understand is worse than none, because the total looks clean.
 */

/** Every category the report can produce. Exhaustive, and `unknown` is one of them. */
export const RECONCILIATION_CATEGORIES = [
  /** An order, a ledger row and an agreeing amount. Nothing to do. */
  'matched',
  /** The gateway says paid; there is no ledger row. The 1,630-order gap (F2). */
  'gateway_success_missing_ledger',
  /** A ledger row exists; the order is not paid. Money recorded, nothing settled. */
  'ledger_missing_gateway',
  /** Both exist and the figures disagree. */
  'amount_mismatch',
  /** Part-order settlement: some allocations are paid, the order is not closed. */
  'partial_allocation',
  /** Two ledger rows, or two references, for one payment. */
  'duplicate',
  /** Recorded as paid by card with no gateway reference at all (F17: 331 orders). */
  'missing_merchant_reference',
  /** A gateway-confirmed payment recorded under a non-gateway method (F3). */
  'method_mismatch',
  /** The gateway was asked and could not answer. 154 orders, N$25,856 (F11). */
  'verification_uncertain',
  /** Classified by nothing above. Surfaced, never dropped. */
  'unknown',
] as const

export type ReconciliationCategory = (typeof RECONCILIATION_CATEGORIES)[number]

/** How urgently a human needs to look. Ordering only -- it decides nothing. */
export const CATEGORY_SEVERITY: Record<ReconciliationCategory, 'ok' | 'review' | 'critical'> = {
  matched: 'ok',
  // Money was taken and nothing durable records it. The largest known gap by value.
  gateway_success_missing_ledger: 'critical',
  // A recorded payment with nothing settled against it: the customer may be asked to pay twice.
  ledger_missing_gateway: 'critical',
  amount_mismatch: 'critical',
  duplicate: 'critical',
  // A real charge whose state is genuinely unknown. Not critical because nothing is yet wrong --
  // it is unresolved, and resolving it wrongly is what would be wrong.
  verification_uncertain: 'review',
  method_mismatch: 'review',
  missing_merchant_reference: 'review',
  partial_allocation: 'ok',
  unknown: 'review',
}

export type ReconciliationOrder = {
  id: string
  order_number?: unknown
  restaurant_id?: unknown
  payment_status?: unknown
  payment_method?: unknown
  total?: unknown
  paid_at?: unknown
  placed_at?: unknown
  paycloud_merchant_order_no?: unknown
  pending_charge_cents?: unknown
}

export type ReconciliationLedgerRow = {
  order_ids?: unknown
  business_order_no?: unknown
  transaction_id?: unknown
  amount?: unknown
  event_type?: unknown
  created_at?: unknown
}

export type ReconciliationFinding = {
  orderId: string
  orderNumber: number | null
  restaurantId: string | null
  category: ReconciliationCategory
  severity: 'ok' | 'review' | 'critical'
  /** One sentence a human can act on. */
  detail: string
  /** The order's own total, in cents. */
  orderAmountCents: number
  /** What the ledger says was collected for it, in cents. Null when there is no ledger row. */
  ledgerAmountCents: number | null
  /** Summed from settled allocations, in cents. Zero for an unsplit order. */
  allocatedAmountCents: number
  merchantOrderNo: string | null
  transactionId: string | null
  paidAt: string | null
}

function cents(major: unknown): number {
  const n = Number(major)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

function text(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return s.length > 0 ? s : null
}

function isPaid(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'paid'
}

export type ClassifyInput = {
  order: ReconciliationOrder
  /** Every sale row naming this order. More than one is itself a finding. */
  ledgerRows: ReconciliationLedgerRow[]
  /** Settled allocation cents for this order. Zero when it was never split. */
  allocatedCents: number
  /** True when a payment.verification_uncertain audit row names this order and it is not paid. */
  hasUnresolvedUncertainty: boolean
}

/**
 * Classify ONE order.
 *
 * A pure function of the evidence, so every category can be tested directly rather than inferred
 * from what a query happened to return. The order of the checks IS the precedence: the first thing
 * that is true about a row is what it is reported as, strongest evidence first.
 */
export function classifyOrder(input: ClassifyInput): ReconciliationFinding {
  const { order, ledgerRows, allocatedCents, hasUnresolvedUncertainty } = input

  const orderId = String(order.id)
  const orderNumber = Number.isFinite(Number(order.order_number))
    ? Number(order.order_number)
    : null
  const restaurantId = text(order.restaurant_id)
  const merchantOrderNo = text(order.paycloud_merchant_order_no)
  const paid = isPaid(order.payment_status)
  const method = String(order.payment_method ?? '').trim().toLowerCase()
  const paidAt = text(order.paid_at)

  const sales = ledgerRows.filter((r) => String(r.event_type ?? 'sale') === 'sale')
  const ledgerAmountCents = sales.length > 0 ? cents(sales[0].amount) : null
  const transactionId = sales.length > 0 ? text(sales[0].transaction_id) : null

  /**
   * THE EXPECTATION, not the order total. `pending_charge_cents` is what the reader was asked for
   * and is the only figure that knows a gratuity was included; comparing a tipped charge against
   * `total` would report a mismatch on every correctly-collected payment.
   */
  const recorded = Number(order.pending_charge_cents)
  const orderAmountCents =
    Number.isFinite(recorded) && recorded > 0 ? Math.round(recorded) : cents(order.total)

  const base = {
    orderId,
    orderNumber,
    restaurantId,
    orderAmountCents,
    ledgerAmountCents,
    allocatedAmountCents: allocatedCents,
    merchantOrderNo,
    transactionId,
    paidAt,
  }

  const finding = (category: ReconciliationCategory, detail: string): ReconciliationFinding => ({
    ...base,
    category,
    severity: CATEGORY_SEVERITY[category],
    detail,
  })

  // ---- duplicates first: two records of one payment outrank what either of them says ---------
  if (sales.length > 1) {
    const refs = [...new Set(sales.map((r) => text(r.business_order_no) ?? '?'))]
    return finding(
      'duplicate',
      `${sales.length} ledger rows name this order (${refs.join(', ')}). One gateway transaction ` +
        'must produce one payment record; check whether the customer was charged twice.',
    )
  }

  // ---- a real charge whose state nobody established ------------------------------------------
  if (hasUnresolvedUncertainty && !paid) {
    return finding(
      'verification_uncertain',
      'The gateway was asked about this payment and could not answer. It is NOT resolved either ' +
        'way -- do not mark it paid and do not cancel it without checking Finatic directly.',
    )
  }

  // ---- part-order settlement ------------------------------------------------------------------
  if (!paid && allocatedCents > 0) {
    return finding(
      'partial_allocation',
      `${allocatedCents} cents of this order have been settled by item; the order is not closed ` +
        'because the rest is still owed. Expected, not an anomaly.',
    )
  }

  if (!paid) {
    if (sales.length > 0) {
      return finding(
        'ledger_missing_gateway',
        'A payment is recorded in the ledger for this order, but the order is not marked paid. ' +
          'The money was collected and the settlement did not land -- the customer may be asked ' +
          'to pay again.',
      )
    }
    // Not paid, nothing collected, nothing uncertain. Simply unpaid; not a reconciliation finding.
    return finding('matched', 'Unpaid, with nothing collected against it. Nothing to reconcile.')
  }

  // ---- from here the order IS paid ------------------------------------------------------------

  /**
   * CASH AND PAYTODAY ARE OUT OF SCOPE, and saying so explicitly matters. Neither has a gateway
   * transaction, so "no ledger row" is correct for them and reporting it would bury the 1,630
   * genuine card gaps under several hundred false ones.
   */
  if (method !== 'card') {
    if (merchantOrderNo || sales.length > 0) {
      return finding(
        'method_mismatch',
        `Recorded as '${method || 'unknown'}' but carries gateway evidence ` +
          `(${merchantOrderNo ?? transactionId}). A gateway-confirmed payment must record the ` +
          'gateway channel.',
      )
    }
    return finding('matched', `Settled by ${method || 'an unrecorded method'}; no gateway involved.`)
  }

  if (!merchantOrderNo) {
    return finding(
      'missing_merchant_reference',
      'Paid by card with no gateway reference, so nothing correlates it to a Finatic ' +
        'transaction. Do NOT invent one -- establish whether it was a legitimate non-Finatic ' +
        'card payment, a legacy order, or a real reconciliation failure.',
    )
  }

  if (sales.length === 0) {
    return finding(
      'gateway_success_missing_ledger',
      `Paid by card under ${merchantOrderNo} with no payment_events row. The money is recorded ` +
        'on the order and nowhere in the ledger, so it cannot be reconciled against Finatic.',
    )
  }

  if (ledgerAmountCents !== null && ledgerAmountCents !== orderAmountCents) {
    return finding(
      'amount_mismatch',
      `The ledger records ${ledgerAmountCents} cents; the order expects ${orderAmountCents}. One ` +
        'of the two is wrong and the difference is real money.',
    )
  }

  return finding('matched', 'Order, ledger and amount all agree.')
}

/** Roll a set of findings up into the counts and values a report leads with. */
export function summarise(findings: ReconciliationFinding[]): {
  total: number
  byCategory: Record<string, { count: number; amountCents: number; severity: string }>
  criticalCount: number
  criticalAmountCents: number
} {
  const byCategory: Record<string, { count: number; amountCents: number; severity: string }> = {}
  let criticalCount = 0
  let criticalAmountCents = 0

  for (const f of findings) {
    const bucket = (byCategory[f.category] ??= {
      count: 0,
      amountCents: 0,
      severity: CATEGORY_SEVERITY[f.category],
    })
    bucket.count += 1
    bucket.amountCents += f.orderAmountCents
    if (f.severity === 'critical') {
      criticalCount += 1
      criticalAmountCents += f.orderAmountCents
    }
  }

  return { total: findings.length, byCategory, criticalCount, criticalAmountCents }
}
