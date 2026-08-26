import { randomBytes } from 'node:crypto'

/**
 * #344 ruling 3 — the handle a human quotes for a stored held payment.
 *
 * WHAT IT IS FOR decides its shape. This id is read off a terminal screen and typed into a
 * message, or said out loud down a phone to someone looking at a gateway statement. Everything
 * below follows from that:
 *
 *   - UPPERCASE, and no lower case anywhere, so case is never a thing to get right.
 *   - The alphabet omits I, L, O, U, 0 and 1. I/L/1 and O/0 are the pairs people mistype; U is
 *     dropped so no run of letters can spell an unfortunate word.
 *   - An `HP-` prefix, so a reference pasted with no context is identifiable as this and not as a
 *     voucher number, a merchant order number or an RCT receipt number.
 *
 * IT IS NOT DERIVED FROM THE IDEMPOTENCY KEY, deliberately. A derived id would encode the
 * businessOrderNo and the millisecond a device held a payment into a string that gets pasted into
 * messages; and it would collide exactly when the key collides, turning one bug into two. Random,
 * stored, and returned unchanged on every re-POST.
 *
 * COLLISION MATH, stated rather than assumed: 30 symbols over 8 places is 30^8 ~= 6.6e11. These
 * rows are produced by a human pressing a button after a terminal crash -- production has fewer
 * than 3600 orders in total -- so a birthday collision at any plausible volume is far below the
 * chance of the gateway losing the transaction. The unique index is on the idempotency key, not on
 * this, so a collision would be a display ambiguity rather than a lost record.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const LENGTH = 8

export function newHeldPaymentReceiptId(): string {
  // rejection-free and unbiased: 30 does not divide 256, so bytes are drawn until each lands in
  // the largest multiple of 30 below 256 (240). Bias here would be harmless, but a comment saying
  // "bias is harmless" ages worse than four lines that have none.
  const out: string[] = []
  while (out.length < LENGTH) {
    for (const byte of randomBytes(LENGTH)) {
      if (byte >= 240) continue
      out.push(ALPHABET[byte % ALPHABET.length])
      if (out.length === LENGTH) break
    }
  }
  return `HP-${out.join('')}`
}

/** The shape, for tests and for anything validating a reference a human typed back. */
export const HELD_PAYMENT_RECEIPT_ID_PATTERN = /^HP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/
