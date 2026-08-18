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

/**
 * DOES A NUMBER EXIST? The same test `orderIdentityLabel` applies, exported so a render site can
 * ask about PROMINENCE without re-deriving it.
 *
 * Needed because "what do I call this order" and "should the name lead the card" are different
 * questions with the same input. My Orders put the label in a bold h3 at the top-left -- the
 * loudest slot on the card -- so an order with no number yet announced ABSENCE more loudly than
 * anything the customer cares about, while the badge beside it already said what was actually
 * happening. That is #296's mistake in a new place: an absent number occupying the headline.
 *
 * A caller that inlines `order.order_number != null` gets the `0` and empty-string cases wrong,
 * which is how the derived-identifier bug reached production twice.
 */
export function hasAllocatedOrderNumber(order: IdentifiableOrder): boolean {
  const raw = order?.order_number
  return (
    raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0
  )
}

export function orderIdentityLabel(order: IdentifiableOrder): string {
  // `0` is not a legal order number here (allocation starts at 1), and an empty string is the
  // shape a mapped request row leaves behind. Both mean "none allocated", same as null -- the
  // test lives in `hasAllocatedOrderNumber` so this function and the render sites cannot disagree.
  if (hasAllocatedOrderNumber(order)) return `Order #${Number(order?.order_number)}`

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
    /**
     * NOTHING, not a placeholder. A dead order has no number and never will, so the honest render
     * is no number line at all -- the card already names the state and carries the decline
     * sentence, so the customer is not left guessing.
     *
     * The card said "See staff" when this was written. It no longer does: `needs_you` was split
     * into four on 2026-08-18 (4e876e4), and `isDeadOrder` is exactly declined-or-cancelled, so
     * the two words a customer actually reads here are now "Not accepted" and "Cancelled". The
     * reasoning is unchanged -- a named state beside a decline sentence still leaves nobody
     * guessing -- but the quoted string was stale and is not restated, because naming one of the
     * four here would go stale again the next time the vocabulary moves.
     * See lib/orders/customer-status.ts for the live words.
     *
     * A WORDED label would be better, and `orderNeverNumbered` is reserved for it in the copy
     * module as PENDING COPY. It is deliberately NOT used yet: the marker text would render
     * literally to a customer, which is worse than the defect it fixes. Wire it up when the
     * wording is signed off.
     */
    return ''
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
