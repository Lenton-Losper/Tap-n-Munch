/**
 * PENDING COPY — the staff-only unpaid-tab-elsewhere flag (#211 follow-up).
 *
 * Placeholder, marked so it cannot ship unnoticed. Copy is the human's.
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
  unpaidTabElsewhere: 'PENDING COPY — Unpaid tab at table {table} ({total})',
} as const
