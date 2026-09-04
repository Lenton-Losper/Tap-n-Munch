/**
 * TAKE PAYMENT BY ITEM -- the copy lock (Ship 1b).
 *
 * PENDING THE OWNER'S SIGN-OFF. The strings below are what has been PROPOSED, pinned so an
 * accidental edit is caught and so the sign-off is a diff against something exact rather than
 * against a memory of a conversation. When the owner signs, the marker goes in
 * constants/takePaymentCopy.ts and this header changes; the strings themselves must not move in
 * either direction without a decision.
 *
 * ALLOCATION_PAYER_AT_TABLE is included even though no waiter ever sees it. It is written to the
 * append-only allocation ledger and reaches reports, which is a longer-lived audience than a
 * screen.
 */
import * as Copy from '../../constants/takePaymentCopy';
import {ALLOCATION_PAYER_AT_TABLE} from '../takePaymentLines';

const PROPOSED = {
  TAKE_PAYMENT_ORDER_HEADING: 'Order #{number}',
  TAKE_PAYMENT_LINE_PAID: 'Paid',
  TAKE_PAYMENT_LINE_NO_PRICE: 'No price — settle this order whole',
  TAKE_PAYMENT_LINE_NOT_CLAIMABLE: 'Cancelled',
  TAKE_PAYMENT_LINE_PART_PAID: '{amount} still owed',
  TAKE_PAYMENT_SELECTION: '{count} items — {amount}',
  TAKE_PAYMENT_SELECTION_ONE: '1 item — {amount}',
  TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER:
    'Card takes a whole order. Tick everything on the order, or take cash.',
  TAKE_PAYMENT_NOT_ITEMISED: 'This tab is not itemised. Paying by order.',
  TAKE_PAYMENT_ALL_PAID: 'Everything on this tab is paid.',
} as const;

describe('Take Payment by item — copy', () => {
  it.each(Object.entries(PROPOSED))('%s is exactly as proposed', (name, text) => {
    expect((Copy as unknown as Record<string, string>)[name]).toBe(text);
  });

  it('exports nothing that has not been listed for sign-off', () => {
    expect(Object.keys(Copy).sort()).toEqual(Object.keys(PROPOSED).sort());
  });

  it('every placeholder a caller substitutes is present', () => {
    expect(PROPOSED.TAKE_PAYMENT_ORDER_HEADING).toContain('{number}');
    expect(PROPOSED.TAKE_PAYMENT_LINE_PART_PAID).toContain('{amount}');
    expect(PROPOSED.TAKE_PAYMENT_SELECTION).toContain('{count}');
    expect(PROPOSED.TAKE_PAYMENT_SELECTION).toContain('{amount}');
    expect(PROPOSED.TAKE_PAYMENT_SELECTION_ONE).toContain('{amount}');
    // The singular does NOT take a count -- it says "1 item", so a {count} here would render raw.
    expect(PROPOSED.TAKE_PAYMENT_SELECTION_ONE).not.toContain('{count}');
  });

  it('the card refusal says what to do instead, not just no', () => {
    expect(PROPOSED.TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER).toMatch(/cash/i);
    expect(PROPOSED.TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER).toMatch(/tick/i);
  });

  it('the unpriced-line label points at the way out', () => {
    expect(PROPOSED.TAKE_PAYMENT_LINE_NO_PRICE).toMatch(/whole/i);
  });

  it('the ledger payer is not a person', () => {
    // Naming the member who placed the round would record that they paid for it, which is the one
    // claim nobody made. See takePaymentLines.
    expect(ALLOCATION_PAYER_AT_TABLE).toBe('Table');
    expect(ALLOCATION_PAYER_AT_TABLE.trim().length).toBeGreaterThan(0);
  });
});
