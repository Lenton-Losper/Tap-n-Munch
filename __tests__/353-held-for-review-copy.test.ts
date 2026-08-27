/**
 * #353 — the signed copy of the "Held for review" surface, and what is deliberately unsigned.
 *
 * EVERY STRING HERE IS A LITERAL. Nothing in this file imports a constant and compares it to
 * itself, and nothing rebuilds a sentence from parts. A copy test that reads
 * `HELD_FOR_REVIEW_CAUSE_COPY.amount_mismatch_hold.why` on both sides of an expectation passes
 * whatever the string is, which makes it decoration. The whole point of pinning copy is that
 * changing the source has to change this file too.
 *
 * TWO SENTENCES ARE PINNED BY OWNER RULING:
 *
 *     'A card may still have been charged on the machine.'
 *     'Nothing has been taken from this order yet.'
 *
 * They are opposites, and each is the single fact that makes its decision possible. So they are
 * asserted three ways: verbatim presence, attachment to the RIGHT cause, and absence from the
 * WRONG one. The third is the one that catches the real failure mode — a refactor that gives
 * both causes a shared default would still satisfy "the sentence appears somewhere", and would
 * tell a staff member that nothing has been taken from an order whose card may well have been
 * charged.
 */
import {
  HELD_FOR_REVIEW_CAUSE_COPY,
  HELD_FOR_REVIEW_SECTION_COPY,
  STRANDED_PENDING_CAUSE,
  STRANDED_PENDING_THRESHOLD_MS,
  UNSIGNED_COPY_MARKER,
  formatHeldDuration,
  heldForReviewCause,
  heldForReviewCopy,
  isSignedCopyCause,
  selectHeldForReviewOrders,
  unsignedCauses,
} from '@/lib/orders/held-for-review'
import { HELD_FOR_REVIEW_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'

const CARD_MAY_HAVE_BEEN_CHARGED = 'A card may still have been charged on the machine.'
const NOTHING_HAS_BEEN_TAKEN = 'Nothing has been taken from this order yet.'

describe('#353 section copy is signed, verbatim', () => {
  it('renders the signed heading', () => {
    expect(HELD_FOR_REVIEW_SECTION_COPY.heading).toBe('Held for review')
  })

  it('renders the signed intro', () => {
    expect(HELD_FOR_REVIEW_SECTION_COPY.intro).toBe(
      'These orders are not paid and are not cancelled. Each one needs a person to decide what happened.',
    )
  })
})

describe('#353 per-cause copy is signed, verbatim', () => {
  it('amount_mismatch_hold', () => {
    expect(HELD_FOR_REVIEW_CAUSE_COPY.amount_mismatch_hold.label).toBe('Amount does not match')
    expect(HELD_FOR_REVIEW_CAUSE_COPY.amount_mismatch_hold.why).toBe(
      'The payment that came back was for a different amount than this order. ' +
        'Nothing has been taken from this order yet.',
    )
  })

  it('verification_unavailable_hold', () => {
    expect(HELD_FOR_REVIEW_CAUSE_COPY.verification_unavailable_hold.label).toBe(
      'Cannot check this payment',
    )
    expect(HELD_FOR_REVIEW_CAUSE_COPY.verification_unavailable_hold.why).toBe(
      'Card payments are not set up at this venue, so we cannot ask the payment provider what ' +
        'happened. A card may still have been charged on the machine.',
    )
  })
})

describe('#353 the two pinned sentences', () => {
  it('"A card may still have been charged on the machine." is present, verbatim', () => {
    expect(HELD_FOR_REVIEW_CAUSE_COPY.verification_unavailable_hold.why).toContain(
      CARD_MAY_HAVE_BEEN_CHARGED,
    )
  })

  it('"Nothing has been taken from this order yet." is present, verbatim', () => {
    expect(HELD_FOR_REVIEW_CAUSE_COPY.amount_mismatch_hold.why).toContain(NOTHING_HAS_BEEN_TAKEN)
  })

  it('the two are NOT interchangeable — neither cause carries the other sentence', () => {
    // The failure this catches: a shared default, or a copy-paste, that tells staff nothing has
    // been taken from an order whose card may already have been charged.
    expect(HELD_FOR_REVIEW_CAUSE_COPY.amount_mismatch_hold.why).not.toContain(
      CARD_MAY_HAVE_BEEN_CHARGED,
    )
    expect(HELD_FOR_REVIEW_CAUSE_COPY.verification_unavailable_hold.why).not.toContain(
      NOTHING_HAS_BEEN_TAKEN,
    )
  })

  it('each pinned sentence survives the lookup a rendered row actually uses', () => {
    // heldForReviewCopy() is what the panel calls. Asserting only the constant would pass with
    // the lookup broken.
    expect(heldForReviewCopy('verification_unavailable_hold').why).toContain(
      CARD_MAY_HAVE_BEEN_CHARGED,
    )
    expect(heldForReviewCopy('amount_mismatch_hold').why).toContain(NOTHING_HAS_BEEN_TAKEN)
  })
})

describe('#353 the hold-status array is consumed, never counted', () => {
  /**
   * THIS TEST MUST PASS ON BOTH BRANCHES. `HELD_FOR_REVIEW_PAYMENT_STATUSES` has one member here
   * and two once #153's `verification_unavailable_hold` merges. Asserting a length would fail
   * today and pass later, or vice versa — which is exactly the kind of assertion that gets
   * deleted rather than understood.
   */
  it('every status in the array has signed copy', () => {
    for (const status of HELD_FOR_REVIEW_PAYMENT_STATUSES) {
      expect(isSignedCopyCause(status)).toBe(true)
    }
  })

  it('EVERY cause the dashboard can render now has signed copy', () => {
    // Was `toEqual([STRANDED_PENDING_CAUSE])` — a tripwire for the moment the owner signed it. It
    // fired on 2026-08-27, correctly, and is replaced rather than deleted: an empty list is the
    // claim that matters now, and it is the one that will fail the day someone adds a fourth hold
    // cause without wording. That is the whole reason this function exists in the code instead of
    // as a note in a report.
    expect(unsignedCauses()).toEqual([])
  })

  it('pins the SIGNED stranded_pending wording character for character', () => {
    // Signed 2026-08-27 after six of these surfaced on a live venue's dashboard reading
    // `COPY NOT SIGNED (stranded_pending)` in front of staff. Exact-string, not "contains the
    // gist": a reword is a second sign-off, and accepting any sentence about an unconfirmed
    // payment would let one through without it.
    const copy = heldForReviewCopy(STRANDED_PENDING_CAUSE)
    expect(copy.label).toBe('Payment never confirmed')
    expect(copy.why).toBe(
      'The card machine reported a problem and the payment provider has no record of this order. ' +
        'Nothing was taken. Decide whether to take payment again or cancel it.',
    )
  })

  it('keeps the three hold causes telling three DIFFERENT stories about the money', () => {
    // The load-bearing property, and the one a shared default would quietly destroy.
    //   amount_mismatch      -> nothing taken FROM THIS ORDER (a payment did arrive, for the wrong amount)
    //   verification_unavail -> a card MAY have been charged; go and check the roll
    //   stranded_pending     -> nothing was taken; act without checking
    // Each sentence licenses a different action. If any two converge, staff are back to guessing.
    expect(heldForReviewCopy('amount_mismatch_hold').why).toContain(
      'Nothing has been taken from this order yet.',
    )
    expect(heldForReviewCopy('verification_unavailable_hold').why).toContain(
      'A card may still have been charged on the machine.',
    )
    expect(heldForReviewCopy(STRANDED_PENDING_CAUSE).why).toContain('Nothing was taken.')

    // ...and the two opposite claims never appear on the same row.
    const stranded = heldForReviewCopy(STRANDED_PENDING_CAUSE).why
    expect(stranded).not.toContain('may still have been charged')
  })

  it('a held order is classified by whatever the array holds, not by a hardcoded name', () => {
    for (const status of HELD_FOR_REVIEW_PAYMENT_STATUSES) {
      expect(heldForReviewCause({ id: 'o1', payment_status: status, placed_at: null })).toBe(status)
    }
  })
})

describe('#353 an unmapped cause reads as unknown, never as fine', () => {
  it('a hold status with no copy gets the unsigned marker, not a friendly default', () => {
    const copy = heldForReviewCopy('some_future_hold')
    expect(copy.label).toContain(UNSIGNED_COPY_MARKER)
    expect(copy.why).toContain(UNSIGNED_COPY_MARKER)
    // The my-orders defect, in the negative: nothing reassuring may appear.
    expect(copy.label.toLowerCase()).not.toContain('new')
    expect(copy.why.toLowerCase()).not.toContain('nothing has been taken')
  })

  it('the stranded cause no longer carries the marker — it is signed', () => {
    // Inverted 2026-08-27 when the owner signed it. The unsigned-fallback MECHANISM is still
    // asserted directly above, against a cause that genuinely has no copy, so retiring this
    // tripwire costs no coverage of the behaviour it was really protecting.
    expect(heldForReviewCopy(STRANDED_PENDING_CAUSE).label).not.toContain(UNSIGNED_COPY_MARKER)
    expect(heldForReviewCopy(STRANDED_PENDING_CAUSE).why).not.toContain(UNSIGNED_COPY_MARKER)
  })

  it('signed copy never carries the marker', () => {
    for (const copy of Object.values(HELD_FOR_REVIEW_CAUSE_COPY)) {
      expect(copy.label).not.toContain(UNSIGNED_COPY_MARKER)
      expect(copy.why).not.toContain(UNSIGNED_COPY_MARKER)
    }
  })
})

describe('#353 classification — what needs a human', () => {
  const NOW = Date.parse('2026-08-27T12:00:00.000Z')
  const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
  const minutesAgo = (n: number) => new Date(NOW - n * 60 * 1000).toISOString()

  it('a stranded pending order is included even though it is plain `pending`', () => {
    expect(
      heldForReviewCause({ id: 'o', payment_status: 'pending', placed_at: daysAgo(35) }, NOW),
    ).toBe(STRANDED_PENDING_CAUSE)
  })

  it('a pending order inside the threshold is left alone — it is still in flight', () => {
    expect(
      heldForReviewCause({ id: 'o', payment_status: 'pending', placed_at: minutesAgo(10) }, NOW),
    ).toBeNull()
  })

  it('a held order is included at ANY age — a gateway has already answered about it', () => {
    expect(
      heldForReviewCause(
        { id: 'o', payment_status: 'amount_mismatch_hold', placed_at: minutesAgo(1) },
        NOW,
      ),
    ).toBe('amount_mismatch_hold')
  })

  it('paid and cancelled orders never appear', () => {
    expect(heldForReviewCause({ id: 'o', payment_status: 'paid', placed_at: daysAgo(40) }, NOW)).toBeNull()
    expect(
      heldForReviewCause({ id: 'o', payment_status: 'cancelled', placed_at: daysAgo(40) }, NOW),
    ).toBeNull()
  })

  it('status=cancelled with payment_status=pending never appears', () => {
    // Production carries exactly this row: a kiosk order, status 'cancelled', payment_status
    // still 'pending', no cancelled_at and no cancellation_reason. The signed heading says these
    // orders "are not cancelled", and every other screen reads that order as cancelled.
    expect(
      heldForReviewCause(
        { id: 'o', payment_status: 'pending', status: 'cancelled', placed_at: daysAgo(40) },
        NOW,
      ),
    ).toBeNull()
  })

  it('a pending order with an unreadable placed_at is included, not dropped', () => {
    // Dropping it would be the invisible-absence shape this surface exists to remove.
    expect(
      heldForReviewCause({ id: 'o', payment_status: 'pending', placed_at: 'not a date' }, NOW),
    ).toBe(STRANDED_PENDING_CAUSE)
  })

  it('normalises a stray casing rather than misclassifying it', () => {
    expect(
      heldForReviewCause({ id: 'o', payment_status: ' Pending ', placed_at: daysAgo(3) }, NOW),
    ).toBe(STRANDED_PENDING_CAUSE)
    expect(heldForReviewCause({ id: 'o', payment_status: ' Paid ', placed_at: daysAgo(3) }, NOW)).toBeNull()
  })

  it('the threshold is two hours, well clear of the slowest payment ever measured (5.9 min)', () => {
    expect(STRANDED_PENDING_THRESHOLD_MS).toBe(2 * 60 * 60 * 1000)
  })

  it('orders come back oldest first, with an unreadable age at the top', () => {
    const rows = selectHeldForReviewOrders(
      [
        { id: 'young', payment_status: 'pending', placed_at: daysAgo(3), total: 10 },
        { id: 'old', payment_status: 'pending', placed_at: daysAgo(35), total: 20 },
        { id: 'ageless', payment_status: 'pending', placed_at: null, total: 30 },
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['ageless', 'old', 'young'])
  })

  it('a POS sale (table_number 0) reports no table rather than "Table 0"', () => {
    const [row] = selectHeldForReviewOrders(
      [{ id: 'p', payment_status: 'pending', placed_at: daysAgo(9), total: 55, table_number: 0 }],
      NOW,
    )
    expect(row.table).toBeNull()
  })

  it('records whether anything could be asked about the order', () => {
    const [withRef] = selectHeldForReviewOrders(
      [
        {
          id: 'a',
          payment_status: 'pending',
          placed_at: daysAgo(9),
          total: 1,
          paycloud_merchant_order_no: 'MO-1',
        },
      ],
      NOW,
    )
    const [withoutRef] = selectHeldForReviewOrders(
      [{ id: 'b', payment_status: 'pending', placed_at: daysAgo(9), total: 1 }],
      NOW,
    )
    expect(withRef.hasGatewayReference).toBe(true)
    expect(withoutRef.hasGatewayReference).toBe(false)
  })
})

describe('#353 duration formatting', () => {
  it('says how long, coarsely', () => {
    expect(formatHeldDuration(35 * 24 * 60 * 60 * 1000)).toBe('35 days')
    expect(formatHeldDuration(24 * 60 * 60 * 1000)).toBe('1 day')
    expect(formatHeldDuration(5 * 60 * 60 * 1000)).toBe('5 hours')
    expect(formatHeldDuration(60 * 60 * 1000)).toBe('1 hour')
    expect(formatHeldDuration(12 * 60 * 1000)).toBe('12 minutes')
    expect(formatHeldDuration(60 * 1000)).toBe('1 minute')
  })

  it('an unknown age says unknown rather than "0 minutes"', () => {
    expect(formatHeldDuration(null)).toBe('unknown')
  })
})
