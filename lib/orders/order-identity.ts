import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'

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
export function orderIdentityLabel(order: { order_number?: unknown } | null | undefined): string {
  const raw = order?.order_number
  // `0` is not a legal order number here (allocation starts at 1), and an empty string is the
  // shape a mapped request row leaves behind. Both mean "none allocated", same as null.
  const hasNumber =
    raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0
  return hasNumber ? `Order #${Number(raw)}` : QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered
}

/**
 * The bare identifier, for surfaces that supply their own "Order" prefix or compose it into a
 * longer sentence. Same rule, same single source.
 */
export function orderNumberOrNotYet(order: { order_number?: unknown } | null | undefined): string {
  const label = orderIdentityLabel(order)
  return label.startsWith('Order #') ? label.slice('Order '.length) : label
}
