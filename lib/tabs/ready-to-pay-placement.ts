/**
 * WHERE "Ready to pay" lives, decided once.
 *
 * RULED by the redesign spec, section 30: *"The primary Ready to Pay action belongs in the
 * shared Tab. … Do not put a primary Ready to Pay button on every individual order
 * confirmation."* The reason given there is a product one — the Tab represents the shared
 * financial relationship, My Orders represents personal food — and the audit turns up a sharper
 * one underneath it.
 *
 * THERE ARE TWO DIFFERENT "CALL THE WAITER" MECHANISMS, WRITING TO TWO DIFFERENT TABLES, WITH
 * NOTHING RECONCILING THEM (audit D8):
 *
 *   the Tab        POST /api/tabs/[tabId]/ready-to-pay  ->  tabs.status = 'ready_to_pay'
 *                                                           tabs.payment_preference
 *   the per-order  ReadyToPayTerminalButton / Cash      ->  orders.customer_ready_to_pay
 *                                                           orders.status = 'ready_for_terminal'
 *
 * On a tab, a customer could press one, then the other, and produce two unrelated signals for
 * one intention — and the terminal reads the tab. So on a tab the per-order affordance is not
 * merely redundant, it is a second answer to a question that already has one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not remove the per-order path. An order with no
 * tab has no tab to settle from, and for that customer the per-order button is the ONLY way to
 * tell staff anything. Removing it everywhere would be tidier and would strand them.
 *
 * So: one rule, several call sites, nothing restated. A site that decides this for itself is how
 * the two mechanisms drifted apart in the first place.
 */

export type ReadyToPayPlacementRow = {
  /** `orders.tab_id` / `order_requests.tab_id`, as the guest read returns it. */
  tab_id?: unknown
}

/** True when this order belongs to a shared tab, and settlement therefore lives on the Tab. */
export function orderIsOnATab(row: ReadyToPayPlacementRow | null | undefined): boolean {
  return Boolean(String(row?.tab_id ?? '').trim())
}

/**
 * Whether a PER-ORDER "ready to pay" control may be offered for this order.
 *
 * `false` for anything on a tab — the Tab owns it. `true` otherwise, because there is no
 * alternative for that customer.
 *
 * A null/absent row returns `true`: this answers "may the control be shown", and refusing on
 * missing data would silently hide the only settlement affordance a non-tab customer has. The
 * failure mode of being wrong in that direction is a duplicate signal; the other direction is a
 * customer who cannot ask to pay.
 */
export function perOrderReadyToPayAllowed(row: ReadyToPayPlacementRow | null | undefined): boolean {
  return !orderIsOnATab(row)
}
