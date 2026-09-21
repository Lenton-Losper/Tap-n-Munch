/**
 * ORDER-LEVEL PAYMENT SUMMARY -- the copy lock.
 *
 * SIGNED BY THE OWNER 2026-09-22. Four strings, pinned as signed. They must not move in either
 * direction without a decision -- the same terms `takePaymentCopySignedOff.test.ts` holds the
 * ten Take Payment strings to, and for the same reason: this is wording on the money screen, and
 * a waiter reading it is deciding whether a table still owes anything.
 *
 * WHY THESE LIVE IN THEIR OWN FILE. `takePaymentCopy.ts` is locked to exactly the ten strings
 * signed on 2026-09-04, and that lock asserts `Object.keys(Copy)` equals them. Adding an eleventh
 * export would have widened a signed list to fit new copy in, which defeats the lock. So the new
 * strings sit in `orderPaymentSummaryCopy.ts` and are pinned here, separately and on their own
 * signature.
 *
 * THE PER-ITEM LABELS ARE NOT TOUCHED BY THIS. TAKE_PAYMENT_LINE_PAID and
 * TAKE_PAYMENT_LINE_PART_PAID still say "Paid" and "{amount} still owed" on each row, and remain
 * locked by their own file. This is the ORDER-level line above them.
 */
import * as Copy from '../../constants/orderPaymentSummaryCopy';

const SIGNED = {
  ORDER_SUMMARY_UNPAID: 'UNPAID · {amount} remaining',
  ORDER_SUMMARY_PARTIAL: '{paid}/{total} PAID · {amount} remaining',
  ORDER_SUMMARY_PAID: 'PAID · {amount}',
  ORDER_SUMMARY_COUNT_ONLY: '{paid}/{total} PAID · amount not known',
} as const;

describe('Order payment summary — copy', () => {
  it.each(Object.entries(SIGNED))('%s is exactly as signed', (name, text) => {
    expect((Copy as unknown as Record<string, string>)[name]).toBe(text);
  });

  it('exports nothing that was not signed', () => {
    expect(Object.keys(Copy).sort()).toEqual(Object.keys(SIGNED).sort());
  });

  it('every placeholder a caller substitutes is present', () => {
    expect(SIGNED.ORDER_SUMMARY_UNPAID).toContain('{amount}');
    expect(SIGNED.ORDER_SUMMARY_PAID).toContain('{amount}');
    for (const s of [SIGNED.ORDER_SUMMARY_PARTIAL, SIGNED.ORDER_SUMMARY_COUNT_ONLY]) {
      expect(s).toContain('{paid}');
      expect(s).toContain('{total}');
    }
    expect(SIGNED.ORDER_SUMMARY_PARTIAL).toContain('{amount}');
  });

  /**
   * THE COUNT-ONLY STRING MUST NOT CARRY A FIGURE. It exists precisely because an order holding an
   * unpriced line has no knowable remainder; substituting one in would print "NAD 0.00 remaining"
   * beside an item nobody has priced, which reads as nothing owed.
   */
  it('the count-only reading states no amount', () => {
    expect(SIGNED.ORDER_SUMMARY_COUNT_ONLY).not.toContain('{amount}');
    expect(SIGNED.ORDER_SUMMARY_COUNT_ONLY).toMatch(/not known/i);
  });

  /**
   * PAID SHOWS WHAT WAS COLLECTED, NOT A REMAINDER. "PAID · N$0.00 remaining" would be true and
   * useless; the figure a waiter wants on a settled order is what the order came to.
   */
  it('the paid reading does not say "remaining"', () => {
    expect(SIGNED.ORDER_SUMMARY_PAID).not.toMatch(/remaining/i);
    expect(SIGNED.ORDER_SUMMARY_UNPAID).toMatch(/remaining/i);
    expect(SIGNED.ORDER_SUMMARY_PARTIAL).toMatch(/remaining/i);
  });

  /**
   * THE THREE STATES MUST READ DIFFERENTLY. The whole point of the change is that a part-paid
   * order stopped being indistinguishable from an untouched one, so two states rendering the same
   * words would silently restore the ambiguity.
   */
  it('no two readings are the same string', () => {
    const values = Object.values(SIGNED);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the partial reading names both the count and the money', () => {
    // "3/4 PAID" alone does not say how much is left; "N$6 remaining" alone does not say how far
    // through the order that is. The signed wording carries both.
    expect(SIGNED.ORDER_SUMMARY_PARTIAL).toMatch(/PAID/);
    expect(SIGNED.ORDER_SUMMARY_PARTIAL).toMatch(/remaining/i);
  });
});
