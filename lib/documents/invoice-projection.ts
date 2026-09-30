/**
 * WHAT AN INVOICE SAYS, DERIVED FROM THE ONE FINANCIAL PROJECTION -- pure, no database.
 *
 * ================================================================================================
 * WHY THIS EXISTS
 * ================================================================================================
 *
 * The first invoice engine (2026-09-13) billed `orders.items` as stored and checked the document
 * against `orders.total`. Both of those INCLUDE voided lines -- `amend_order_lines` never rewrites
 * the original order -- so the check could not catch the defect it sat next to: an amended order
 * was invoiced for food that was taken off the bill, and a reduced line was billed twice (once on
 * the original, once on its replacement order).
 *
 * Every figure here comes from lib/orders/order-financials.ts (computeOrderFinancials /
 * computeTabFinancials). Nothing in this file re-derives live, paid or outstanding. What this file
 * adds is only what an invoice needs on top of the projection:
 *
 *   - which lines are CHARGED (the projection's live lines) and which are CANCELLED (its voided
 *     lines, and every line of a cancelled order), so the document can show both;
 *   - whether the money on each order can still move (eligibility, below);
 *   - how the projection's `paid` breaks down into payments a customer can recognise (method and
 *     reference), without ever dividing one gateway sale across the orders it covered.
 *
 * ================================================================================================
 * ELIGIBILITY: "CAN THE TOTAL STILL CHANGE?"  (Sprint 2026-09-28 brief; replaces 'completed' only)
 * ================================================================================================
 *
 * An invoice is immutable once issued; a total that moves afterwards manufactures a correction.
 * The 2026-09-13 rule answered that by allowing status 'completed' and nothing else, which made an
 * UNPAID or PARTIALLY PAID invoice impossible for the ordinary tab (its rounds are never
 * 'completed' until the table is cleared) -- and the brief requires both.
 *
 * The only thing that changes an order's money after it is placed is `amend_order_lines`, and it
 * can touch a line only while EVERY station that owns it is still 'outstanding' (its WHERE clause,
 * 20260829150000). So an order is FINAL -- its total cannot change through the normal flow -- when:
 *
 *   1. it is PAID                       money was collected against the figure; a later void is a
 *                                       refund, which is a credit note's job (as ORDER_REFUNDED); or
 *   2. its status is 'completed'        the 2026-09-13 rule, kept: staff have declared it final; or
 *   3. every line has an order_lines    no line is still inside the amend window: each is voided
 *      row and none is amendable        or at least one owning station has started on it.
 *
 * An order with NO line rows (pre-20260827, or a failed insert) cannot be judged by rule 3 and is
 * final only by rules 1 or 2 -- fail toward refusing, never toward issuing a document that moves.
 *
 * Never final, whatever the above says:
 *   - `requires_reacceptance`           its total is not agreed yet;
 *   - a card payment in flight or held  (terminal_pending, amount_mismatch_hold,
 *                                        verification_unavailable_hold) -- what was paid is not
 *                                        known, so "amount paid" on the invoice would be a guess;
 *   - refunded                          a credit note's job, never a smaller invoice.
 *
 * A TAB is final when every order on it is (cancelled orders are fine -- they are shown as
 * cancelled and charge nothing). A tab can still gain rounds; those are NEW orders the invoice
 * does not cover, and the document records exactly which orders it covers (`order_ids`), so "one
 * live invoice per order" holds regardless.
 */

import {
  computeOrderFinancials,
  computeTabFinancials,
  FINANCIAL_ORDER_COLUMNS,
  FINANCIAL_LINE_COLUMNS,
  type FinancialLineInput,
  type FinancialOrderInput,
  type LineFinancials,
  type OrderFinancials,
} from '@/lib/orders/order-financials'
import { isPaidPaymentStatus, isMidFlightCardPayment, isHeldForReviewPaymentStatus } from '@/lib/payments/payment-integrity'
import { buildVariantDisplayName } from '@/lib/menu/variant-groups'
import type { LineItemInput } from '@/lib/documents/create-document'

// ── columns ──────────────────────────────────────────────────────────────────────────────────

/**
 * The projection's own columns PLUS what an invoice prints. Built from FINANCIAL_ORDER_COLUMNS
 * rather than copied, so a column the projection gains (e.g. `settled_charge_cents`) is selected
 * here the moment it is added there -- see written-columns-are-not-selected.
 */
const INVOICE_EXTRA_ORDER_COLUMNS = [
  'restaurant_id',
  'order_number',
  'placed_at',
  'table_number',
  'requires_reacceptance',
  'payment_method',
  'payment_reference',
  'paycloud_merchant_order_no',
  'paid_at',
]

export function mergeColumns(...lists: Array<string | readonly string[]>): string {
  const out: string[] = []
  for (const list of lists) {
    const parts = typeof list === 'string' ? list.split(',') : list
    for (const raw of parts) {
      const column = raw.trim()
      if (column && !out.includes(column)) out.push(column)
    }
  }
  return out.join(', ')
}

export const INVOICE_ORDER_COLUMNS = mergeColumns(FINANCIAL_ORDER_COLUMNS, INVOICE_EXTRA_ORDER_COLUMNS)
export const INVOICE_LINE_COLUMNS = FINANCIAL_LINE_COLUMNS

// ── types ────────────────────────────────────────────────────────────────────────────────────

export type InvoiceOrderRow = FinancialOrderInput & {
  restaurant_id?: string | null
  order_number?: number | null
  placed_at?: string | null
  table_number?: number | null
  requires_reacceptance?: boolean | null
  payment_method?: string | null
  payment_reference?: string | null
  paycloud_merchant_order_no?: string | null
  paid_at?: string | null
}

/** A line that was ordered and is NOT charged. Stored on `business_documents.cancelled_line_items`. */
export type CancelledInvoiceLine = {
  description: string
  quantity: number
  unit_price: number
  /** What the line would have cost. Shown for recognition; never part of any total. */
  line_total: number
  order_number: number | null
  reason: 'voided' | 'order_cancelled'
}

export type InvoiceRefusalCode =
  | 'ORDER_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'ORDER_IS_SETTLEMENT_RECORD'
  | 'ORDER_NOT_FINAL'
  | 'ORDER_AWAITING_REACCEPTANCE'
  | 'ORDER_REFUNDED'
  | 'PAYMENT_UNRESOLVED'
  | 'PAYMENT_STATE_UNRECOGNISED'
  | 'OVERPAID'
  | 'ORDER_HAS_NO_LINES'
  | 'ORDER_TOTAL_UNUSABLE'
  | 'BILLING_PROFILE_INCOMPLETE'
  | 'INVOICE_ALREADY_EXISTS'
  /** Two creates for one bill withdrew each other; a retry issues exactly one (RC-ORDERS M). */
  | 'INVOICE_CREATE_CONFLICT'
  | 'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER'
  | 'DOCUMENT_BALANCE_DISAGREES'
  | 'PAYMENT_LEDGER_DISAGREES'

export type InvoiceRefusal = { ok: false; code: InvoiceRefusalCode; message: string }

export type InvoicePlan = {
  ok: true
  /** Orders the invoice covers (settlement artefacts excluded; cancelled orders included). */
  coveredOrderIds: string[]
  perOrder: OrderFinancials[]
  /** Projection totals, integer cents. `liveCents` is what the document total must equal. */
  liveCents: number
  paidCents: number
  outstandingCents: number
  voidedCents: number
  invoiceLines: LineItemInput[]
  /** Σ of the charged lines, cents -- must equal liveCents before a number is burned. */
  invoiceLinesCents: number
  cancelledLines: CancelledInvoiceLine[]
}

// ── predicates ───────────────────────────────────────────────────────────────────────────────

/**
 * Inside the amend window: every OWNED station is still 'outstanding'. Verbatim the WHERE clause
 * `amend_order_lines` voids under (20260829150000); a line matching it can still leave the bill.
 * This is not a money formula -- it decides eligibility, not an amount.
 */
export function isAmendableLine(line: Pick<FinancialLineInput, 'kitchen_state' | 'bar_state'>): boolean {
  const owned = [line.kitchen_state, line.bar_state].filter((s): s is string => s != null)
  return owned.length > 0 && owned.every((s) => s === 'outstanding')
}

function orderLabel(order: Pick<InvoiceOrderRow, 'order_number' | 'id'>): string {
  return order.order_number != null ? `#${order.order_number}` : String(order.id).slice(0, 8)
}

function refusal(code: InvoiceRefusalCode, message: string): InvoiceRefusal {
  return { ok: false, code, message }
}

/** Why an order's money could still move, or null when it cannot. */
export function whyNotFinal(
  order: InvoiceOrderRow,
  financials: OrderFinancials,
  lines: readonly FinancialLineInput[],
): string | null {
  if (isPaidPaymentStatus(order.payment_status)) return null
  if (String(order.status ?? '').toLowerCase() === 'completed') return null
  if (financials.lineCoverage !== 'full') {
    return (
      `Order ${orderLabel(order)} is still ${order.status ?? 'in progress'} and has no item-level ` +
      'record to show its items can no longer change. Mark it completed first.'
    )
  }
  const own = lines.filter((l) => String(l.order_id) === String(order.id))
  const open = own.filter(isAmendableLine).length
  if (open > 0) {
    return (
      `Order ${orderLabel(order)} still has ${open} item${open === 1 ? '' : 's'} nobody has started, ` +
      'which can still be taken off the bill. Mark them ready (or the order completed) first.'
    )
  }
  return null
}

// ── lines ────────────────────────────────────────────────────────────────────────────────────

/**
 * The description a customer reads. The projection's name is `displayName ?? name`; a variant
 * selection that is not already spelled out in it is appended with the SAME builder pricing uses
 * (buildVariantDisplayName), so the invoice says "Flat White - Large", never just "Flat White".
 */
export function describeLine(line: Pick<LineFinancials, 'name' | 'selectedVariants'>): string {
  const name = line.name.trim() || 'Item'
  const selection = line.selectedVariants
  if (!selection) return name
  const labels = Object.values(selection).filter(Boolean)
  if (labels.length === 0 || labels.every((label) => name.includes(label))) return name
  return buildVariantDisplayName(name, selection)
}

/**
 * One projection line -> one document line, charged at EXACTLY the projection's line total.
 *
 * The engine computes line_total = quantity × unit_price, so unit_price is the projection's unit
 * when that multiplies back to the line total, else line total ÷ quantity when that is exact.
 * Where neither is exact (a line total that does not divide by its quantity), the line is
 * presented as ONE unit at its total, with the quantity kept in the description: the charged
 * figure is never rounded to fit a unit price.
 */
export function toInvoiceLine(line: LineFinancials, rawItem: unknown): LineItemInput | null {
  if (!(line.quantity > 0) || line.totalCents < 0) return null
  const item = (rawItem && typeof rawItem === 'object' ? rawItem : {}) as Record<string, unknown>
  const taxRateId = item.taxRateId ?? item.tax_rate_id
  const tax_rate_id = typeof taxRateId === 'string' && taxRateId ? taxRateId : null
  const description = describeLine(line)

  if (Math.round(line.unitCents * line.quantity) === line.totalCents) {
    return { description, quantity: line.quantity, unit_price: line.unitCents / 100, tax_rate_id }
  }
  const perUnit = line.totalCents / line.quantity
  if (Number.isInteger(perUnit)) {
    return { description, quantity: line.quantity, unit_price: perUnit / 100, tax_rate_id }
  }
  return {
    description: `${line.quantity} × ${description}`,
    quantity: 1,
    unit_price: line.totalCents / 100,
    tax_rate_id,
  }
}

function toCancelledLine(
  line: LineFinancials,
  order: InvoiceOrderRow,
  reason: CancelledInvoiceLine['reason'],
): CancelledInvoiceLine | null {
  if (!(line.quantity > 0) && line.totalCents === 0) return null
  return {
    description: describeLine(line),
    quantity: line.quantity,
    unit_price: line.unitCents / 100,
    line_total: line.totalCents / 100,
    order_number: order.order_number ?? null,
    reason,
  }
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────

/**
 * Everything an invoice will say, or why it cannot be issued. Pure.
 *
 * `scope: 'order'` takes exactly one order; `scope: 'tab'` takes every order on the tab and drops
 * settlement artefacts the way computeTabFinancials does.
 */
export function planInvoice(input: {
  scope: 'order' | 'tab'
  orders: readonly InvoiceOrderRow[]
  lines: readonly FinancialLineInput[]
  settledByOrder: ReadonlyMap<string, number>
  refundedOrderIds: ReadonlySet<string>
}): InvoicePlan | InvoiceRefusal {
  const { scope, lines, settledByOrder, refundedOrderIds } = input

  let perOrder: OrderFinancials[]
  if (scope === 'order') {
    const [order] = input.orders
    if (!order || input.orders.length !== 1) {
      return refusal('ORDER_NOT_FOUND', 'That order could not be found at this venue.')
    }
    const f = computeOrderFinancials(order, lines, settledByOrder.get(String(order.id)) ?? 0)
    if (f.isSettlementArtefact) {
      return refusal(
        'ORDER_IS_SETTLEMENT_RECORD',
        'This row records the payment of a tab, not food. Invoice the tab instead.',
      )
    }
    if (f.cancelled) {
      return refusal(
        'ORDER_CANCELLED',
        'This order was cancelled, so it cannot be invoiced. Invoicing a cancelled order would ' +
          'bill a customer for food that was never supplied.',
      )
    }
    perOrder = [f]
  } else {
    perOrder = computeTabFinancials(input.orders, lines, settledByOrder).orders
  }

  const orderById = new Map(input.orders.map((o) => [String(o.id), o]))

  // ── eligibility, per order ──────────────────────────────────────────────────────────────
  for (const f of perOrder) {
    if (f.cancelled) continue
    const order = orderById.get(f.orderId)!
    if (order.requires_reacceptance === true) {
      return refusal(
        'ORDER_AWAITING_REACCEPTANCE',
        `Order ${orderLabel(order)} was edited and is waiting to be re-accepted. Settle that first ` +
          '— its total is not final yet.',
      )
    }
    if (refundedOrderIds.has(f.orderId)) {
      return refusal(
        'ORDER_REFUNDED',
        `Money has been refunded against order ${orderLabel(order)}, so a plain invoice would ` +
          'overstate what is owed. Raise the invoice for the original sale and issue a credit note ' +
          'for the refund.',
      )
    }
    if (isMidFlightCardPayment(order.payment_status) || isHeldForReviewPaymentStatus(order.payment_status)) {
      return refusal(
        'PAYMENT_UNRESOLVED',
        `A card payment on order ${orderLabel(order)} is still in progress or held for review ` +
          `(${order.payment_status}), so what has been paid is not known yet. Resolve it first.`,
      )
    }
    const notFinal = whyNotFinal(order, f, lines)
    if (notFinal) return refusal('ORDER_NOT_FINAL', notFinal)
  }

  // ── lines: charged vs cancelled ─────────────────────────────────────────────────────────
  const invoiceLines: LineItemInput[] = []
  const cancelledLines: CancelledInvoiceLine[] = []
  let invoiceLinesCents = 0
  for (const f of perOrder) {
    const order = orderById.get(f.orderId)!
    const rawItems = Array.isArray(order.items) ? (order.items as unknown[]) : []
    for (const line of f.lines) {
      if (f.cancelled || line.voided) {
        const cancelled = toCancelledLine(line, order, f.cancelled ? 'order_cancelled' : 'voided')
        if (cancelled) cancelledLines.push(cancelled)
        continue
      }
      const invoiceLine = toInvoiceLine(line, rawItems[line.sourceItemIndex])
      if (!invoiceLine) continue
      invoiceLines.push(invoiceLine)
      invoiceLinesCents += line.totalCents
    }
  }

  const sum = (k: 'liveCents' | 'paidCents' | 'outstandingCents' | 'overpaidCents' | 'voidedCents') =>
    perOrder.reduce((s, f) => s + f[k], 0)
  const liveCents = sum('liveCents')
  const paidCents = sum('paidCents')
  const outstandingCents = sum('outstandingCents')
  const overpaidCents = sum('overpaidCents')

  if (invoiceLines.length === 0) {
    return refusal('ORDER_HAS_NO_LINES', 'There are no charged items left to invoice.')
  }
  if (liveCents <= 0) {
    return refusal('ORDER_TOTAL_UNUSABLE', 'There is no amount owed for these items, so there is nothing to invoice.')
  }

  /**
   * OVERPAID IS REFUSED. More was collected than the live bill -- a void after payment, or a legacy
   * whole-order charge that included lines later voided. The customer is owed money back; an
   * invoice would state a negative balance and hide the refund. That is a refund/credit-note job.
   */
  if (overpaidCents > 0) {
    return refusal(
      'OVERPAID',
      `N$${(overpaidCents / 100).toFixed(2)} more was collected than these items now come to. ` +
        'Refund or credit the difference first; an invoice cannot show it.',
    )
  }

  /**
   * THE PROJECTION'S OWN IDENTITY, per order: what is owed is exactly what is live minus what is
   * paid. It fails only for a payment status that neither owes money nor is paid (an unknown or
   * write-off state), where the invoice's balance (total − paid) would disagree with the
   * projection's outstanding. Refused rather than guessed.
   */
  for (const f of perOrder) {
    if (f.cancelled) continue
    if (f.liveCents - f.paidCents !== f.outstandingCents - f.overpaidCents) {
      const order = orderById.get(f.orderId)!
      return refusal(
        'PAYMENT_STATE_UNRECOGNISED',
        `Order ${orderLabel(order)} has payment status "${order.payment_status ?? 'none'}", which is ` +
          'neither paid nor owing, so the invoice cannot say what is outstanding.',
      )
    }
  }

  /**
   * CHECKED BEFORE A DOCUMENT NUMBER IS BURNED. `live` is subtractive (stored total − voided), so an
   * order whose stored total differs from Σ its items (an order-level adjustment) cannot be listed
   * line by line without misstating one or the other.
   */
  if (invoiceLinesCents !== liveCents) {
    return refusal(
      'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER',
      `The charged items add up to N$${(invoiceLinesCents / 100).toFixed(2)} but the bill is ` +
        `N$${(liveCents / 100).toFixed(2)}. The invoice was not issued.`,
    )
  }

  return {
    ok: true,
    coveredOrderIds: perOrder.map((f) => f.orderId),
    perOrder,
    liveCents,
    paidCents,
    outstandingCents,
    voidedCents: sum('voidedCents'),
    invoiceLines,
    invoiceLinesCents,
    cancelledLines,
  }
}

// ── payments ─────────────────────────────────────────────────────────────────────────────────

export type AllocationSettlementRow = {
  order_id: string
  amount_cents: number
  method: string | null
  payment_reference: string | null
  settled_at: string | null
}

export type SaleEventRow = {
  order_ids: unknown
  transaction_id: string | null
  business_order_no: string | null
  created_at: string | null
}

/** One `document_payments` row: a payment the customer can recognise. Integer cents. */
export type InvoicePaymentRecord = {
  amountCents: number
  method: string
  reference: string | null
  paidAt: string | null
}

/**
 * HOW THE PROJECTION'S `paid` BREAKS DOWN INTO PAYMENTS.
 *
 * Every AMOUNT here is the projection's, per order: the item-ledger part is settledByOrder (what
 * the projection used), and the whole-order part is paidCents − that. A payment_event contributes
 * ONLY its method-side identity (transaction id / merchant order number) and its time -- never its
 * `amount`. One sale event can cover several orders (the Riviera N$220 + N$500 = N$720 settlement),
 * and attributing its amount to each order would count it twice; it is the orders' own figures,
 * grouped under the shared reference, that add back up to the event.
 *
 * Grouped by (method, reference), so a tab settled by one card payment is ONE line on the invoice.
 * Refuses (null) if the item-ledger rows read for labelling do not add up to what the projection
 * used -- two reads that disagree mean something was settled in between, and the invoice would
 * state a paid figure nobody can reconcile.
 */
export function invoicePaymentRecords(input: {
  perOrder: readonly OrderFinancials[]
  orders: readonly InvoiceOrderRow[]
  settledByOrder: ReadonlyMap<string, number>
  allocationSettlements: readonly AllocationSettlementRow[]
  saleEvents: readonly SaleEventRow[]
}): InvoicePaymentRecord[] | null {
  const orderById = new Map(input.orders.map((o) => [String(o.id), o]))
  const groups = new Map<string, InvoicePaymentRecord>()
  const add = (method: string, reference: string | null, cents: number, at: string | null) => {
    if (cents <= 0) return
    const key = `${method}\u0000${reference ?? ''}`
    const existing = groups.get(key)
    if (existing) {
      existing.amountCents += cents
      if (at && (!existing.paidAt || at > existing.paidAt)) existing.paidAt = at
    } else {
      groups.set(key, { amountCents: cents, method, reference, paidAt: at })
    }
  }

  let total = 0
  for (const f of input.perOrder) {
    const order = orderById.get(f.orderId)
    if (!order || f.paidCents <= 0) continue
    total += f.paidCents

    const allocCents = Math.max(0, Math.round(Number(input.settledByOrder.get(f.orderId) ?? 0)))
    const rows = input.allocationSettlements.filter((r) => String(r.order_id) === f.orderId)
    const rowsCents = rows.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount_cents) || 0)), 0)
    if (rowsCents !== allocCents) return null
    for (const r of rows) {
      add(
        String(r.method || 'unknown'),
        String(r.payment_reference ?? '').trim() || null,
        Math.max(0, Math.round(Number(r.amount_cents) || 0)),
        r.settled_at ?? null,
      )
    }

    const wholeOrderCents = f.paidCents - allocCents
    if (wholeOrderCents > 0) {
      const events = input.saleEvents
        .filter((e) => Array.isArray(e.order_ids) && (e.order_ids as unknown[]).map(String).includes(f.orderId))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      const event = events[0]
      const reference =
        String(event?.transaction_id ?? '').trim() ||
        String(event?.business_order_no ?? '').trim() ||
        String(order.payment_reference ?? '').trim() ||
        String(order.paycloud_merchant_order_no ?? '').trim() ||
        null
      add(
        String(order.payment_method || 'unknown'),
        reference,
        wholeOrderCents,
        event?.created_at ?? order.paid_at ?? null,
      )
    }
  }

  const records = [...groups.values()].sort((a, b) =>
    String(a.paidAt ?? '').localeCompare(String(b.paidAt ?? '')),
  )
  const recordedCents = records.reduce((s, r) => s + r.amountCents, 0)
  return recordedCents === total ? records : null
}
