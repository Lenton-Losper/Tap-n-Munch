/**
 * The staff-only unpaid-tab-elsewhere flag (#211 follow-up). Signed off by the human 2026-08-15.
 *
 * STAFF-ONLY, and that is a ruling rather than an implementation detail: nothing in the customer
 * app reads this string or the column behind it. It is a prompt for the floor, not an accusation
 * shown to the person it is about.
 *
 * FLAG, NOT BLOCK. Ordering, accepting, preparing and settling all proceed exactly as they would
 * without it. The only thing that changes is that staff can see it before the second tab is
 * settled and the customer leaves.
 *
 * `{table}` is the OTHER table's number and `{total}` its running total, both taken from the
 * linked tab as it stands right now — so the figure is current, not the figure at creation.
 */
export const TAB_FLAG_COPY = {
  /** Rendered on an order card whose tab was opened while another tab was still unpaid. */
  unpaidTabElsewhere: 'Unpaid tab — Table {table} ({total})',
  /**
   * PENDING COPY. Appended inside `{total}` when the other table also has money the restaurant
   * has not answered yet (#286).
   *
   * The figure before it is PAYABLE — what settlement would charge. This one is submitted and
   * unanswered, and it is shown because the badge DISPLAYS; nothing here decides anything. A
   * staff member who reads only the payable figure could walk to a table believing it owes N$95
   * when the diners have also ordered N$132 the kitchen has not been given yet.
   */
  unpaidTabElsewherePendingSuffix: 'PENDING COPY — awaiting confirmation',
} as const
