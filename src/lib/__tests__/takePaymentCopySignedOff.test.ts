/**
 * TAKE PAYMENT BY ITEM -- the copy lock (Ship 1b).
 *
 * SIGNED BY THE OWNER 2026-09-04. Ten strings plus the ledger's payer label, pinned as signed.
 * They must not move in either direction without a decision.
 *
 * ONE STRING WAS CHANGED AT SIGN-OFF: TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER. The proposed wording
 * made the card the actor ("Card takes a whole order") and said "everything on the order", which
 * does not name WHICH order on a tab carrying several -- the exact situation the message appears
 * in. The reasoning is recorded on the constant itself.
 *
 * ALLOCATION_PAYER_AT_TABLE is locked here even though no waiter ever sees it. It is written to
 * the append-only allocation ledger and reaches reports, which is a longer-lived audience than a
 * screen.
 */
import * as Copy from '../../constants/takePaymentCopy';
import {ALLOCATION_PAYER_AT_TABLE} from '../takePaymentLines';

const SIGNED = {
  TAKE_PAYMENT_ORDER_HEADING: 'Order #{number}',
  TAKE_PAYMENT_LINE_PAID: 'Paid',
  TAKE_PAYMENT_LINE_NO_PRICE: 'No price — settle this order whole',
  TAKE_PAYMENT_LINE_NOT_CLAIMABLE: 'Cancelled',
  TAKE_PAYMENT_LINE_PART_PAID: '{amount} still owed',
  TAKE_PAYMENT_SELECTION: '{count} items — {amount}',
  TAKE_PAYMENT_SELECTION_ONE: '1 item — {amount}',
  TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER:
    'Card payments cover a whole order. Tick the whole order, or take cash for these items.',
  TAKE_PAYMENT_NOT_ITEMISED: 'This tab is not itemised. Paying by order.',
  TAKE_PAYMENT_ALL_PAID: 'Everything on this tab is paid.',
} as const;

describe('Take Payment by item — copy', () => {
  it.each(Object.entries(SIGNED))('%s is exactly as signed', (name, text) => {
    expect((Copy as unknown as Record<string, string>)[name]).toBe(text);
  });

  it('exports nothing that was not signed', () => {
    expect(Object.keys(Copy).sort()).toEqual(Object.keys(SIGNED).sort());
  });

  it('every placeholder a caller substitutes is present', () => {
    expect(SIGNED.TAKE_PAYMENT_ORDER_HEADING).toContain('{number}');
    expect(SIGNED.TAKE_PAYMENT_LINE_PART_PAID).toContain('{amount}');
    expect(SIGNED.TAKE_PAYMENT_SELECTION).toContain('{count}');
    expect(SIGNED.TAKE_PAYMENT_SELECTION).toContain('{amount}');
    expect(SIGNED.TAKE_PAYMENT_SELECTION_ONE).toContain('{amount}');
    // The singular does NOT take a count -- it says "1 item", so a {count} here would render raw.
    expect(SIGNED.TAKE_PAYMENT_SELECTION_ONE).not.toContain('{count}');
  });

  it('the card refusal says what to do instead, not just no', () => {
    expect(SIGNED.TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER).toMatch(/cash/i);
    expect(SIGNED.TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER).toMatch(/tick/i);
  });

  it('the unpriced-line label points at the way out', () => {
    expect(SIGNED.TAKE_PAYMENT_LINE_NO_PRICE).toMatch(/whole/i);
  });

  it('the ledger payer is not a person', () => {
    // Naming the member who placed the round would record that they paid for it, which is the one
    // claim nobody made. See takePaymentLines.
    expect(ALLOCATION_PAYER_AT_TABLE).toBe('Table');
    expect(ALLOCATION_PAYER_AT_TABLE.trim().length).toBeGreaterThan(0);
  });
});
