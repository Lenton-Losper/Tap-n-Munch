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
import { owesMoney, roundToCents } from '@/lib/payments/payment-integrity'

export type TabOrderRow = {
  total?: unknown
  payment_status?: unknown
  tab_settlement_for_tab_id?: unknown
}

/** The columns this module needs. Kept here so callers cannot under-select and get a wrong sum. */
export const TAB_TOTAL_ORDER_COLUMNS = 'total, payment_status, tab_settlement_for_tab_id'

function isSettlementArtefact(row: TabOrderRow): boolean {
  return Boolean(String(row.tab_settlement_for_tab_id ?? '').trim())
}

function amount(row: TabOrderRow): number {
  const n = Number(row.total)
  return Number.isFinite(n) ? n : 0
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
export function computeTabOutstanding(rows: readonly TabOrderRow[] | null | undefined): number {
  const list = Array.isArray(rows) ? rows : []
  return roundToCents(
    list
      .filter((row) => !isSettlementArtefact(row) && owesMoney(row.payment_status))
      .reduce((sum, row) => sum + amount(row), 0),
  )
}

/**
 * GROSS ORDERED — everything the table has ordered, paid or not.
 *
 * A DIFFERENT QUESTION, exported under its own name so a caller that genuinely wants it has to
 * say so and label it. No customer surface uses it today. If one starts to, the label it renders
 * must not read as "what you owe".
 */
export function computeTabGrossOrdered(rows: readonly TabOrderRow[] | null | undefined): number {
  const list = Array.isArray(rows) ? rows : []
  return roundToCents(
    list.filter((row) => !isSettlementArtefact(row)).reduce((sum, row) => sum + amount(row), 0),
  )
}
