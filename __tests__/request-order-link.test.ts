import { findLinkDisagreement } from '@/lib/orders/request-order-link'

/**
 * The point of two links is that they fail differently. These cases are named after the write
 * that went missing, because "they disagree" is not actionable and "the finalize never landed" is.
 */
describe('findLinkDisagreement', () => {
  it('is silent when a request has simply not been answered yet', () => {
    // The normal resting state. Neither link exists and nothing is wrong.
    expect(
      findLinkDisagreement({
        requestId: 'r1',
        requestStatus: 'waiting_review',
        acceptedOrderId: null,
        orderIdFromReverseLink: null,
      }),
    ).toBeNull()
  })

  it('is silent when both halves agree', () => {
    expect(
      findLinkDisagreement({
        requestId: 'r1',
        requestStatus: 'accepted',
        acceptedOrderId: 'o1',
        orderIdFromReverseLink: 'o1',
      }),
    ).toBeNull()
  })

  /**
   * The failure the reverse link exists to make visible: the Accept route inserted the order and
   * then died before the finalize UPDATE. Money exists as an order; the request still looks
   * unfinished. Before this column there was nothing in the schema that could show it.
   */
  it('names the case where the order exists but the finalize never landed', () => {
    const d = findLinkDisagreement({
      requestId: 'r1',
      requestStatus: 'accepting',
      acceptedOrderId: null,
      orderIdFromReverseLink: 'o1',
    })
    expect(d?.kind).toBe('order_exists_but_request_not_finalised')
    expect(d?.detail).toContain('o1')
  })

  it('names an accepted request with no forward link as a MISSING CONSTRAINT, not a missing write', () => {
    // order_requests_accepted_has_order forbids this. Seeing it means the CHECK is absent here.
    const d = findLinkDisagreement({
      requestId: 'r1',
      requestStatus: 'accepted',
      acceptedOrderId: null,
      orderIdFromReverseLink: null,
    })
    expect(d?.kind).toBe('accepted_without_forward_link')
    expect(d?.detail).toContain('CHECK')
  })

  it('catches the two halves naming DIFFERENT orders', () => {
    const d = findLinkDisagreement({
      requestId: 'r1',
      requestStatus: 'accepted',
      acceptedOrderId: 'o1',
      orderIdFromReverseLink: 'o2',
    })
    expect(d?.kind).toBe('request_claims_an_order_that_does_not_point_back')
  })

  it('flags a forward link with no reverse, and says why it is expected on old rows', () => {
    const d = findLinkDisagreement({
      requestId: 'r1',
      requestStatus: 'accepted',
      acceptedOrderId: 'o1',
      orderIdFromReverseLink: null,
    })
    expect(d?.kind).toBe('request_claims_an_order_that_does_not_point_back')
    expect(d?.detail).toContain('20260816090000')
  })

  it('treats blank strings as absent, so a NULL and an empty column read the same', () => {
    expect(
      findLinkDisagreement({
        requestId: 'r1',
        requestStatus: 'waiting_review',
        acceptedOrderId: '   ',
        orderIdFromReverseLink: '',
      }),
    ).toBeNull()
  })

  /** It must never guess. There is no code path that infers a link from totals or timestamps. */
  it('never invents a link — a disagreement is reported, not resolved', () => {
    const d = findLinkDisagreement({
      requestId: 'r1',
      requestStatus: 'accepting',
      acceptedOrderId: null,
      orderIdFromReverseLink: 'o1',
    })
    expect(Object.keys(d ?? {})).toEqual(['requestId', 'kind', 'detail'])
  })
})
