/**
 * THE GRATUITY SECTION: amount, picker, and the guards around them.
 *
 * These assert CONDITIONS, not marker strings. Asserting that a label or an error code appears
 * proves a branch was written and nothing about whether it runs — that mistake produced four
 * defects in the web repo on 2026-09-05, every one of which looked covered.
 */
import {amountToCents, gratuityExtras, NO_GRATUITY} from '../GratuitySection';

describe('a keyed amount becomes integer cents', () => {
  it('converts what a waiter actually types', () => {
    // Staff key major units off a bill. They never see cents.
    expect(amountToCents('12.50')).toBe(1250);
    expect(amountToCents('5')).toBe(500);
    expect(amountToCents('0.05')).toBe(5);
  });

  it('ROUNDS rather than truncates, so a half-cent cannot vanish', () => {
    // 12.505 * 100 is 1250.4999... in binary floating point; truncation would silently drop it.
    expect(amountToCents('12.505')).toBe(1251);
    expect(amountToCents('0.015')).toBe(2);
  });

  it('treats anything unparseable as NO gratuity, never as a charge', () => {
    for (const raw of ['', '   ', 'abc', '-5', '0', '0.00']) {
      expect(amountToCents(raw)).toBe(0);
    }
  });

  it('ignores currency decoration a waiter might type', () => {
    expect(amountToCents('N$ 12.50')).toBe(1250);
    expect(amountToCents('12,50')).toBe(1250);
  });
});

describe('what reaches the settle call', () => {
  it('sends NOTHING when there is no gratuity, so an absent key means no tip', () => {
    expect(gratuityExtras(NO_GRATUITY)).toEqual({});
    expect(Object.keys(gratuityExtras(NO_GRATUITY))).toHaveLength(0);
  });

  it('sends both fields together when there is one', () => {
    expect(
      gratuityExtras({tipCents: 1250, tipStaffUserId: 'user-9', valid: true}),
    ).toEqual({tipCents: 1250, tipStaffUserId: 'user-9'});
  });

  it('REFUSES to send an amount with nobody attached', () => {
    // The server rejects this (TIP_NEEDS_STAFF) and the charge button is disabled on `valid`.
    // This is the third guard on the same rule, not the only one — and the one that stops a
    // malformed request being built at all.
    expect(gratuityExtras({tipCents: 1250, tipStaffUserId: null, valid: false})).toEqual({});
  });

  it('refuses a zero or negative amount even if somebody is chosen', () => {
    expect(gratuityExtras({tipCents: 0, tipStaffUserId: 'user-9', valid: true})).toEqual({});
    expect(gratuityExtras({tipCents: -1, tipStaffUserId: 'user-9', valid: true})).toEqual({});
  });
});

describe('the resting state', () => {
  it('is valid, so a waiter taking no gratuity is never blocked', () => {
    // No tip is the common case and must stay one tap: NO_GRATUITY has to pass validation or
    // every ordinary settlement would be gated behind a picker nobody opened.
    expect(NO_GRATUITY.valid).toBe(true);
    expect(NO_GRATUITY.tipCents).toBe(0);
    expect(NO_GRATUITY.tipStaffUserId).toBeNull();
  });
});

describe('the separator hazards, which are 100x mistakes', () => {
  /**
   * A COMMA DECIMAL IS THE LOCAL CONVENTION. The first implementation stripped it, so "12,50"
   * read as "1250" whole units and became N$1250.00 instead of N$12.50 — a 100x overcharge on a
   * customer's gratuity. Caught by this test, not by review.
   */
  it('reads a comma as the decimal point, not as a thousands separator', () => {
    expect(amountToCents('12,50')).toBe(1250);
    expect(amountToCents('0,05')).toBe(5);
    expect(amountToCents('100,00')).toBe(10000);
  });

  it('still reads a period decimal the same way', () => {
    expect(amountToCents('12.50')).toBe(1250);
  });

  it('treats the LAST separator as the decimal point when both appear', () => {
    expect(amountToCents('1,250.00')).toBe(125000);
    expect(amountToCents('1.250,00')).toBe(125000);
  });

  it('a typed minus is a mis-key, never a negative gratuity', () => {
    // Stripping the sign first turned "-5" into a five-unit tip.
    expect(amountToCents('-5')).toBe(0);
    expect(amountToCents('-12.50')).toBe(0);
  });
});
