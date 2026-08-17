/**
 * The two halves of the order_request <-> order relationship, and the assertion that they agree.
 *
 * RULED 2026-08-16: populate BOTH, and assert they agree. "I'd rather have two writes that can
 * disagree loudly than one that can be silently absent" — which is the failure this replaces.
 *
 *   FORWARD   order_requests.accepted_order_id -> orders.id
 *             Written by the Accept route's finalize UPDATE, a SEPARATE statement from the order
 *             insert. It can lag, and if the worker dies between the two it never lands at all —
 *             the route already documents that a row can strand in `accepting`.
 *
 *   REVERSE   orders.source_request_id -> order_requests.id
 *             Written by the order's own INSERT (20260816090000). Cannot lag: there is no moment
 *             at which the order exists without it.
 *
 * They are not redundant, because they fail differently. The reverse link is the one that is
 * always present when the order is; the forward link is the one that says the request was
 * FINALISED. A disagreement is therefore meaningful rather than noise, and it names which of the
 * two writes went missing.
 */

export type LinkPair = {
  /** `order_requests.id` */
  requestId: string
  /** `order_requests.status` */
  requestStatus: string
  /** `order_requests.accepted_order_id` — the forward link. */
  acceptedOrderId: string | null
  /** `orders.id` of the row whose `source_request_id` points at this request, if one exists. */
  orderIdFromReverseLink: string | null
}

export type LinkDisagreement = {
  requestId: string
  kind:
    /** An order points back at this request, but the request never recorded it. The Accept route
     *  died between the insert and the finalize, or the finalize lost its CAS. Money exists as an
     *  order; the request still looks unfinished. */
    | 'order_exists_but_request_not_finalised'
    /** The request claims an order that does not point back. Either the order predates
     *  20260816090000, or the two links were written about different rows. */
    | 'request_claims_an_order_that_does_not_point_back'
    /** status='accepted' with no forward link. The CHECK constraint
     *  order_requests_accepted_has_order should make this impossible; seeing it means the
     *  constraint is absent on this environment. */
    | 'accepted_without_forward_link'
  detail: string
}

/**
 * Compare the two halves for one request. Returns null when they agree.
 *
 * Deliberately does NOT treat "no order yet" as a disagreement: a `waiting_review` request with
 * neither link is the normal resting state, not a fault.
 *
 * Deliberately does NOT infer anything. If the two halves disagree it says so and names which
 * write is missing; it never guesses which order a request became. Reconstructing a financial
 * link by matching totals and timestamps is how a wrong guess becomes invisible truth, and the
 * reverse column exists precisely so that guess is never needed.
 */
export function findLinkDisagreement(pair: LinkPair): LinkDisagreement | null {
  const status = String(pair.requestStatus || '').trim().toLowerCase()
  const forward = String(pair.acceptedOrderId ?? '').trim() || null
  const reverse = String(pair.orderIdFromReverseLink ?? '').trim() || null

  if (status === 'accepted' && !forward) {
    return {
      requestId: pair.requestId,
      kind: 'accepted_without_forward_link',
      detail:
        'status=accepted with accepted_order_id NULL. order_requests_accepted_has_order should ' +
        'forbid this; if it is present, the CHECK is missing on this database.',
    }
  }

  if (reverse && !forward) {
    return {
      requestId: pair.requestId,
      kind: 'order_exists_but_request_not_finalised',
      detail: `order ${reverse} points at this request, but accepted_order_id is NULL (status=${status}).`,
    }
  }

  if (forward && reverse && forward !== reverse) {
    return {
      requestId: pair.requestId,
      kind: 'request_claims_an_order_that_does_not_point_back',
      detail: `accepted_order_id=${forward} but the order pointing back is ${reverse}.`,
    }
  }

  if (forward && !reverse) {
    return {
      requestId: pair.requestId,
      kind: 'request_claims_an_order_that_does_not_point_back',
      detail:
        `accepted_order_id=${forward} but no order carries source_request_id for this request. ` +
        'Expected for any order accepted before migration 20260816090000.',
    }
  }

  return null
}
