/**
 * What a table owes, computed from the orders — the single authoritative answer.
 *
 * RULED by the human 2026-08-15, after the audit measured what `tabs.total` actually is.
 *
 * WHY COMPUTED AND NOT STORED. `tabs.total` had FIVE writers using TWO incompatible
 * definitions, and seven money-changing events that skipped it entirely (order cancel, terminal
 * order creation on a tab, refund, terminal payment failure, request decline, table close,
 * terminal order status change). Measured on production 2026-08-15: of 20 tabs carrying orders,
 * the two definitions agreed on ONE — 13 rows stored "gross ordered" and 6 stored "still
 * outstanding", decided by whichever writer touched the row last.
 *
 * The ruling, in the human's words: a correctness obligation spread across twelve-plus write
 * sites, which every future money route inherits and nothing detects a miss in, "is not a design;
 * it's the bug's cause". So the number is derived on read, here, once.
 *
 * WHAT THE NUMBER MEANS: STILL OUTSTANDING. What the customer owes right now. Gross ordered is a
 * DIFFERENT question, and a screen showing it as "what you owe" is lying — the same shape as the
 * client sum this replaces. It has its own function below, and a caller that wants it asks for it
 * by name and labels it as such. Do not add a mode flag to one function; that is how the two
 * definitions got into one column in the first place.
 *
 * `owesMoney` is IMPORTED, never restated. It is the same predicate the terminal settle route and
 * markOrderPaidConfirmed use to decide what is still owed, and a second copy of it would be the
 * #278 class of bug applied to money. If a payment status is added, it is added there and every
 * consumer including this one follows.
 */
import { roundToCents } from '@/lib/payments/payment-integrity'
import { effectiveRequestPricing } from '@/lib/orders/order-request-pricing'
import {
  centsToMajor,
  computeTabFinancials,
  type FinancialLineInput,
  type FinancialOrderInput,
} from '@/lib/orders/order-financials'

/**
 * AMENDED TABS (Sprint 2026-09-28). `amend_order_lines` never rewrites an order, so `total` keeps
 * counting voided lines and a reduction's surviving quantity is owed again on a replacement order.
 * The figures below are therefore computed through the ONE financial projection
 * (lib/orders/order-financials.ts) rather than by summing `total`. `owesMoney` still decides what
 * is owed -- it is applied inside the projection, not restated here.
 *
 * A caller that passes the tab's order_lines (and item-ledger settlements) gets voided lines and
 * part-payments taken off. A caller that cannot -- a row without an `id` cannot be joined to its
 * lines -- gets the projection's no-coverage answer, which is `total` for an order that owes money:
 * it fails toward owing, never toward letting a table close over unpaid food.
 */
export type TabOrderRow = {
  id?: unknown
  total?: unknown
  items?: unknown
  status?: unknown
  payment_status?: unknown
  tab_settlement_for_tab_id?: unknown
  settled_charge_cents?: unknown
}

/** The projection's other two inputs, when the caller has read them. */
export type TabProjectionInputs = {
  lines?: readonly FinancialLineInput[]
  /** Σ item-ledger settlement cents per order id (settledCentsByOrder). */
  allocationSettledByOrder?: ReadonlyMap<string, number>
}

function projectTab(rows: readonly TabOrderRow[] | null | undefined, inputs?: TabProjectionInputs) {
  const list = Array.isArray(rows) ? rows : []
  const orders: FinancialOrderInput[] = list.map((row, index) => ({
    // A row read without its id cannot match a line; a synthetic id keeps it a distinct order.
    id: String(row.id ?? '').trim() || `__row_${index}`,
    total: row.total,
    items: row.items,
    status: row.status == null ? null : String(row.status),
    payment_status: row.payment_status == null ? null : String(row.payment_status),
    tab_settlement_for_tab_id:
      row.tab_settlement_for_tab_id == null ? null : String(row.tab_settlement_for_tab_id),
    settled_charge_cents:
      row.settled_charge_cents == null ? null : Number(row.settled_charge_cents),
  }))
  return computeTabFinancials(orders, inputs?.lines ?? [], inputs?.allocationSettledByOrder ?? new Map())
}

/** The columns this module needs. Kept here so callers cannot under-select and get a wrong sum. */
export const TAB_TOTAL_ORDER_COLUMNS = 'total, payment_status, tab_settlement_for_tab_id'

/**
 * The request columns PENDING needs. `*_reviewed` and `*_customer` are here because
 * effectiveRequestPricing resolves `reviewed ?? customer ?? original` — pricing a pending request
 * from the raw `total` would show the customer a figure a staff review has already moved.
 *
 * NOTE the `*_customer` columns exist on cloudflare-staging only (migration 20260813120000). On a
 * database without them PostgREST omits the keys, effectiveRequestPricing sees `undefined`, and
 * precedence falls through to the original submission. That degrades safely, but it means this
 * computes from a different tier per environment — stated so it is not discovered as a discrepancy.
 */
export const TAB_PENDING_REQUEST_COLUMNS =
  'status, items, subtotal, tax, total, items_reviewed, subtotal_reviewed, tax_reviewed, total_reviewed, items_customer, subtotal_customer, tax_customer, total_customer'

/**
 * The ONLY request status that counts as pending.
 *
 * RULED 2026-08-15: "pending means the restaurant has not yet answered. The moment it answers, the
 * money belongs to the order or to nobody."
 *
 *   waiting_review  the restaurant has not answered            -> PENDING
 *   accepting       it is answering; the claim has been taken  -> excluded, see the note below
 *   accepted        answered yes; the money is now an `orders` row and payable counts it
 *   declined        answered no; not owed and not pending, EXCLUDED EXPLICITLY rather than
 *                   incidentally — the same reasoning as a cancelled order in QRA-15
 *
 * WHY EXCLUDING `accepting` IS SAFE, and why it is not free. The Accept route claims the request
 * into `accepting` BEFORE it inserts the order, so by the time an order exists the request has
 * already left this set — the same money can never be in both figures. That ordering exists to
 * satisfy the order_requests_accepted_has_order CHECK, not for this, so we are relying on it:
 * if Accept ever inserts first, this becomes a double count.
 *
 * The cost is a window between the claim landing and the insert returning in which the money is in
 * NEITHER figure. One round trip normally, and permanent for a row stranded in `accepting` — which
 * the Accept route documents as possible. Named rather than designed around.
 */
export const TAB_PENDING_REQUEST_STATUSES = ['waiting_review'] as const

/** Statuses explicitly NOT pending, listed so the exclusion is a decision and not a side effect. */
export const TAB_NOT_PENDING_REQUEST_STATUSES = ['accepting', 'accepted', 'declined'] as const

/**
 * EXPORTED so the shared-tab order list (lib/tabs/tab-order-groups.ts) can exclude exactly what
 * the totals exclude. A private second copy over there would let the list and the figure disagree
 * about what counts as a diner's food -- the #278 class applied to money.
 */
export function isSettlementArtefact(row: TabOrderRow): boolean {
  return Boolean(String(row.tab_settlement_for_tab_id ?? '').trim())
}

/**
 * STILL OUTSTANDING — the authoritative "what does this table owe right now".
 *
 * Two exclusions, and they are not the same kind of thing:
 *
 *  1. `owesMoney(payment_status)` — a paid or cancelled order is not owed. This is the exclusion
 *     that the three "gross" writers of tabs.total omitted, which is why a cancelled order kept
 *     being shown as money due (QRA-15) and why a paid order was re-included the next time
 *     someone ordered.
 *
 *  2. Settlement artefacts. An order carrying `tab_settlement_for_tab_id` represents a PAYMENT of
 *     a tab, not a line the table ordered; counting an unpaid one would double the bill. The
 *     terminal settle route does NOT apply this exclusion, so this is deliberately stricter than
 *     the existing writer — bounded by measurement rather than assumed: on 2026-08-15 there were
 *     ZERO such orders on staging and ZERO on production, so it changes no row today. It is here
 *     so that the first one to exist cannot silently double a total.
 */
export function computeTabOutstanding(
  rows: readonly TabOrderRow[] | null | undefined,
  inputs?: TabProjectionInputs,
): number {
  return centsToMajor(projectTab(rows, inputs).outstandingCents)
}

/**
 * GROSS ORDERED — everything the table has ordered, paid or not.
 *
 * A DIFFERENT QUESTION, exported under its own name so a caller that genuinely wants it has to
 * say so and label it. No customer surface uses it today. If one starts to, the label it renders
 * must not read as "what you owe".
 */
export function computeTabGrossOrdered(
  rows: readonly TabOrderRow[] | null | undefined,
  inputs?: TabProjectionInputs,
): number {
  // Everything ordered, paid or not, cancelled or not -- LESS what was voided off it. A voided line
  // was never ordered in any sense a bill cares about; counting it is the #160 defect.
  const tab = projectTab(rows, inputs)
  return centsToMajor(tab.orders.reduce((sum, o) => sum + (o.originalCents - o.voidedCents), 0))
}

export type TabRequestRow = {
  status?: unknown
  total?: unknown
  total_reviewed?: unknown
  total_customer?: unknown
  items?: unknown
  items_reviewed?: unknown
  items_customer?: unknown
}

/**
 * PENDING — submitted by a customer, not yet answered by the restaurant.
 *
 * Display only. Nothing that DECIDES may use this: the restaurant has not agreed to make it, its
 * price can still move at review, and it can be declined outright. Settlement charges `payable`.
 */
export function computeTabPending(rows: readonly TabRequestRow[] | null | undefined): number {
  const list = Array.isArray(rows) ? rows : []
  return roundToCents(
    list
      .filter((row) =>
        (TAB_PENDING_REQUEST_STATUSES as readonly string[]).includes(
          String(row.status ?? '').trim().toLowerCase(),
        ),
      )
      .reduce((sum, row) => sum + (Number(effectiveRequestPricing(row).total) || 0), 0),
  )
}

export type TabFigures = {
  /** Accepted and unpaid. What settlement charges. The only figure a decision may use. */
  payable: number
  /** Submitted and unanswered. Display only. */
  pending: number
}

/**
 * Both figures, from one place.
 *
 * RULED: two figures everywhere — anything that DECIDES uses `payable`, anything that DISPLAYS
 * shows both. They are returned together so a caller cannot take one and forget the other, and
 * they are never summed here: the sum is a presentation choice and belongs at the render site.
 */
export function computeTabFigures(
  orders: readonly TabOrderRow[] | null | undefined,
  requests: readonly TabRequestRow[] | null | undefined,
  inputs?: TabProjectionInputs,
): TabFigures {
  return { payable: computeTabOutstanding(orders, inputs), pending: computeTabPending(requests) }
}

/**
 * Customer-facing copy for the pending figure. Signed off by the human 2026-08-16, so no PENDING
 * COPY marker and no "PENDING" in the name: nothing here is a placeholder any more.
 *
 * `{pending}` is substituted at the render site by plain `.replace()`, so it must stay literal.
 * The amount is dynamic — the signed-off text was given with a worked example (N$107.00) and the
 * token is what ships.
 *
 * `tabPendingSuffix` CARRIES ITS OWN SEPARATOR. It is appended to a total that is already
 * rendered, so the render site must not add another middot.
 */
export const TAB_FIGURES_COPY = {
  /** Appended after the tab total wherever the total is shown inline. Includes the separator. */
  tabPendingSuffix: '· {pending} awaiting confirmation',
  /** In the settle sheet, so the button's figure and the screen's figure cannot disagree. */
  settleSheetPendingNotice:
    '{pending} is still waiting for the restaurant to confirm. You can pay for it once they do.',
  /** On My Orders, where a customer looks after ordering. */
  myOrdersPendingNotice:
    '{pending} is still waiting for the restaurant to confirm. You can pay for it once they do.',
} as const
