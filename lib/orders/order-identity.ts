import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { isDeadOrder } from '@/lib/orders/customer-status'

/**
 * How a customer surface names an order. ONE answer, because five surfaces gave five (#308).
 *
 * THE RULE, ruled by #296 and restated by B2: an `order_requests` row has NO number until staff
 * Accept allocates one — the table has no `order_number` column at all. A submission that has not
 * been accepted therefore reads the signed-off "not yet numbered" phrase, never an identifier
 * derived from anything else.
 *
 * WHY THIS IS A FUNCTION AND NOT A CONVENTION. #296 fixed the confirmation page and left the
 * decision written out at each site — `order_number != null ? #n : notYetNumbered` — with a
 * comment saying it was "REUSED, not re-invented". It was reused in two places and re-invented as
 * `order_number || id.slice(-6).toUpperCase()` in four others, which shipped to production and was
 * caught on a real table showing `Order #DBA21A` for an order_request whose UUID ended
 * `…f738e8dba21a`. That is the #278 class: one question, several private answers. A convention
 * cannot be enforced; a function can.
 *
 * WHY THE DERIVED FORM IS WORSE THAN NO NUMBER. The tail of a UUID is a number the restaurant
 * cannot look up. A customer reading it to staff gets a blank look; it collides with nothing in the
 * kitchen's world and matches nothing on the dashboard. Saying "not numbered yet" is the truth and
 * is actionable — it tells them the restaurant has not answered.
 *
 * Deliberately NOT a fallback chain. There is no third thing to try: either a number was allocated
 * or it was not.
 */
export type IdentifiableOrder = {
  order_number?: unknown
  /** Read so a DEAD order is not told a number is still coming. See below. */
  status?: unknown
  payment_status?: unknown
} | null | undefined

export function orderIdentityLabel(order: IdentifiableOrder): string {
  const raw = order?.order_number
  // `0` is not a legal order number here (allocation starts at 1), and an empty string is the
  // shape a mapped request row leaves behind. Both mean "none allocated", same as null.
  const hasNumber =
    raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0
  if (hasNumber) return `Order #${Number(raw)}`

  /**
   * THE THIRD ANSWER, added 2026-08-18 after a production click test.
   *
   * "Not numbered yet" says: submitted, awaiting acceptance, no number allocated YET. On a
   * DECLINED order that is a promise that cannot be kept -- three of them were found on a real
   * customer session, each headed "Not numbered yet", ten hours after being refused. The string
   * was right and the condition rendering it was wrong.
   *
   * This is the THIRD time a number-rendering branch has been wrong (#296 invented "Order #0",
   * #308 invented one from the UUID tail), and the reason the answer lives in this function
   * rather than at each site: two of the eight call sites still inlined the constant and are
   * routed through here by the same change.
   */
  if (isDeadOrder({ status: order?.status, paymentStatus: order?.payment_status })) {
    return QR_REDESIGN_PENDING_COPY.orderNeverNumbered
  }
  return QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered
}

/**
 * The bare identifier, for surfaces that supply their own "Order" prefix or compose it into a
 * longer sentence. Same rule, same single source.
 */
export function orderNumberOrNotYet(order: IdentifiableOrder): string {
  const label = orderIdentityLabel(order)
  return label.startsWith('Order #') ? label.slice('Order '.length) : label
}
