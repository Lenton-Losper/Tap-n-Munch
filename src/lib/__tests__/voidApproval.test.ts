/**
 * WHAT COUNTS AS A VOID, AND WHEN THE APPROVE BUTTON MAY BE PRESSED.
 *
 * These assert CONDITIONS, not marker strings. Asserting that a copy constant appears somewhere
 * proves a branch was written and nothing about whether it runs — that mistake produced five
 * defects in the web repo on 2026-09-05 and 09-06, every one of which looked covered.
 */
import {
  isReduction,
  MAX_VOID_REASON_LENGTH,
  MIN_VOID_REASON_LENGTH,
  reductionEffect,
  voidApprovalComplete,
  voidFailureMessage,
  type VoidApprovalDraft,
} from '../voidApproval';
import {AMEND_EFFECT_CHANGE, AMEND_EFFECT_REMOVE} from '../../constants/amendCopy';
import {
  VOID_EFFECT_REDUCE,
  VOID_EFFECT_REDUCE_ONE,
  VOID_NEEDS_AUTHORIZATION,
  VOID_NEEDS_REASON,
  VOID_REASON_TOO_LONG,
  VOID_REFUSED_PIN,
} from '../../constants/voidCopy';

const draft = (over: Partial<VoidApprovalDraft> = {}): VoidApprovalDraft => ({
  staffUserId: 'user-1',
  name: 'Lenton',
  pin: '1234',
  reason: 'Customer changed their mind',
  ...over,
});

describe('any reduction is a void, not just a removal', () => {
  it('gates 3 to 1, which takes two dishes off the bill', () => {
    // The bypass this exists to close. Gating only zero means a waiter reduces instead of removes.
    expect(isReduction(3, 1)).toBe(true);
  });

  it('gates a removal', () => {
    expect(isReduction(3, 0)).toBe(true);
    expect(isReduction(1, 0)).toBe(true);
  });

  it('does NOT gate an increase or an unchanged quantity', () => {
    // An increase adds to what the customer owes. Nobody needs to approve that.
    expect(isReduction(1, 3)).toBe(false);
    expect(isReduction(2, 2)).toBe(false);
  });

  it('does not turn an unreadable quantity into a void', () => {
    // An unknown line must not silently demand a PIN; the server refuses the line anyway.
    expect(isReduction(NaN, 1)).toBe(false);
    expect(isReduction(3, NaN)).toBe(false);
    expect(isReduction(Infinity, 1)).toBe(false);
  });
});

describe('the Approve button', () => {
  it('is dead until somebody is named, a PIN is typed and a reason is given', () => {
    expect(voidApprovalComplete(draft())).toBe(true);
    expect(voidApprovalComplete(null)).toBe(false);
    expect(voidApprovalComplete(draft({staffUserId: ''}))).toBe(false);
    expect(voidApprovalComplete(draft({pin: ''}))).toBe(false);
    expect(voidApprovalComplete(draft({reason: ''}))).toBe(false);
  });

  it('does not accept whitespace as a PIN or a reason', () => {
    // Trimmed, because '   ' is a filled-looking field that authorises and explains nothing.
    expect(voidApprovalComplete(draft({pin: '   '}))).toBe(false);
    expect(voidApprovalComplete(draft({reason: '     '}))).toBe(false);
  });

  it('wants a reason somebody can read later, not a keypress', () => {
    expect(voidApprovalComplete(draft({reason: 'x'.repeat(MIN_VOID_REASON_LENGTH - 1)}))).toBe(
      false,
    );
    expect(voidApprovalComplete(draft({reason: 'x'.repeat(MIN_VOID_REASON_LENGTH)}))).toBe(true);
  });

  it('stops at the length the SERVER stops at', () => {
    // Beyond this the route answers VOID_REASON_TOO_LONG, having told the customer it came off.
    expect(voidApprovalComplete(draft({reason: 'x'.repeat(MAX_VOID_REASON_LENGTH)}))).toBe(true);
    expect(voidApprovalComplete(draft({reason: 'x'.repeat(MAX_VOID_REASON_LENGTH + 1)}))).toBe(
      false,
    );
  });
});

describe('what the waiter reads under the stepper', () => {
  it('says the money comes off when it does, not what the kitchen sees', () => {
    /**
     * AMEND_EFFECT_CHANGE describes the kitchen's view and says nothing about a bill. A manager
     * asked to approve 3→1 having read only that has been told the wrong thing about money.
     */
    expect(reductionEffect(3, 1)).toBe(VOID_EFFECT_REDUCE.replace('{count}', '2'));
    expect(reductionEffect(3, 1)).not.toBe(AMEND_EFFECT_CHANGE);
    expect(reductionEffect(3, 1)).toContain('2');
  });

  it('reads as English for one item', () => {
    expect(reductionEffect(2, 1)).toBe(VOID_EFFECT_REDUCE_ONE);
    expect(reductionEffect(2, 1)).not.toContain('1 off');
  });

  it('a removal keeps the removal wording', () => {
    expect(reductionEffect(3, 0)).toBe(AMEND_EFFECT_REMOVE);
  });

  it('an increase keeps the ordinary change wording', () => {
    expect(reductionEffect(1, 3)).toBe(AMEND_EFFECT_CHANGE);
    expect(reductionEffect(2, 2)).toBe(AMEND_EFFECT_CHANGE);
  });
});

describe('a refusal is put into words that say nothing changed', () => {
  it('maps every code the route can answer with', () => {
    expect(voidFailureMessage('AUTHORIZATION_INVALID')).toBe(VOID_REFUSED_PIN);
    expect(voidFailureMessage('AUTHORIZATION_REQUIRED')).toBe(VOID_REFUSED_PIN);
    expect(voidFailureMessage('VOID_NEEDS_AUTHORIZATION')).toBe(VOID_NEEDS_AUTHORIZATION);
    expect(voidFailureMessage('VOID_NEEDS_REASON')).toBe(VOID_NEEDS_REASON);
    expect(voidFailureMessage('VOID_REASON_TOO_LONG')).toBe(VOID_REASON_TOO_LONG);
  });

  it('every one of them tells the waiter the bill is unchanged', () => {
    /**
     * The load-bearing half. The waiter has already told the customer the item is coming off; a
     * refusal that does not say otherwise leaves them believing it did.
     */
    for (const code of [
      'AUTHORIZATION_INVALID',
      'AUTHORIZATION_REQUIRED',
      'VOID_NEEDS_AUTHORIZATION',
      'VOID_NEEDS_REASON',
      'VOID_REASON_TOO_LONG',
    ]) {
      const message = voidFailureMessage(code);
      expect({code, message}).toEqual({code, message: expect.any(String)});
      expect({code, saysUnchanged: /nothing (has )?(came|changed)/i.test(message!)}).toEqual({
        code,
        saysUnchanged: true,
      });
    }
  });

  it('hands an unknown code back rather than inventing wording for it', () => {
    // The caller has a fallback. A guess here would be an unsigned string on a money screen.
    expect(voidFailureMessage('AMEND_FAILED')).toBeNull();
    expect(voidFailureMessage(null)).toBeNull();
    expect(voidFailureMessage('SOMETHING_NEW')).toBeNull();
  });
});
