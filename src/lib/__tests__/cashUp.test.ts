/**
 * WHEN THE CASH-UP MAY BE PRINTED, AND WHAT A REFUSAL SAYS.
 *
 * These assert CONDITIONS, not marker strings. Asserting that a copy constant exists proves a
 * branch was written and nothing about whether it runs — five defects on 2026-09-05 and 09-06 came
 * from exactly that.
 */
import {cashUpFailureMessage, cashUpReady, type CashUpDraft} from '../cashUp';
import {
  CASH_UP_NEEDS_AUTHORIZATION,
  CASH_UP_PRINTER_FAILED,
  CASH_UP_REFUSED_PIN,
  CASH_UP_REPORT_FAILED,
} from '../../constants/cashUpCopy';

const draft = (over: Partial<CashUpDraft> = {}): CashUpDraft => ({
  staffUserId: 'mgr-1',
  name: 'Lenton',
  pin: '1234',
  ...over,
});

describe('the Print button', () => {
  it('needs somebody named AND a PIN', () => {
    expect(cashUpReady(draft())).toBe(true);
    expect(cashUpReady(null)).toBe(false);
    expect(cashUpReady(draft({staffUserId: ''}))).toBe(false);
    expect(cashUpReady(draft({pin: ''}))).toBe(false);
  });

  it('does not accept whitespace as a PIN', () => {
    // A filled-looking field that authorises nothing.
    expect(cashUpReady(draft({pin: '   '}))).toBe(false);
    expect(cashUpReady(draft({staffUserId: '  '}))).toBe(false);
  });
});

describe('a refusal is put into words that say nothing printed', () => {
  it('maps every code the flow can produce', () => {
    expect(cashUpFailureMessage('AUTHORIZATION_INVALID')).toBe(CASH_UP_REFUSED_PIN);
    expect(cashUpFailureMessage('AUTHORIZATION_REQUIRED')).toBe(CASH_UP_REFUSED_PIN);
    expect(cashUpFailureMessage('PIN_MISMATCH')).toBe(CASH_UP_REFUSED_PIN);
    expect(cashUpFailureMessage('CASH_UP_NEEDS_AUTHORIZATION')).toBe(CASH_UP_NEEDS_AUTHORIZATION);
    expect(cashUpFailureMessage('INVALID_PRESET')).toBe(CASH_UP_REPORT_FAILED);
    expect(cashUpFailureMessage('PRINT_FAILED')).toBe(CASH_UP_PRINTER_FAILED);
    expect(cashUpFailureMessage('CASH_UP_FORMAT_UNAVAILABLE')).toBe(CASH_UP_PRINTER_FAILED);
  });

  it('every one of them tells the manager nothing came out', () => {
    /**
     * The load-bearing half. A manager who cannot tell whether the slip printed will print it
     * again, and then has two pieces of paper and no idea which is right.
     */
    for (const code of [
      'AUTHORIZATION_INVALID',
      'AUTHORIZATION_REQUIRED',
      'PIN_MISMATCH',
      'CASH_UP_NEEDS_AUTHORIZATION',
      'INVALID_PRESET',
      'PRINT_FAILED',
      'CASH_UP_FORMAT_UNAVAILABLE',
    ]) {
      const message = cashUpFailureMessage(code);
      expect({code, message}).toEqual({code, message: expect.any(String)});
      expect({code, saysNothingPrinted: /nothing (was|has)/i.test(message!)}).toEqual({
        code,
        saysNothingPrinted: true,
      });
    }
  });

  it('a rejected PIN does NOT read as a broken report, and vice versa', () => {
    // They send the manager to different places: one to the person, one to the printer.
    expect(cashUpFailureMessage('AUTHORIZATION_INVALID')).not.toBe(
      cashUpFailureMessage('PRINT_FAILED'),
    );
    expect(cashUpFailureMessage('PRINT_FAILED')).not.toBe(cashUpFailureMessage('INVALID_PRESET'));
  });

  it('hands an unknown code back rather than inventing wording', () => {
    expect(cashUpFailureMessage('SOMETHING_NEW')).toBeNull();
    expect(cashUpFailureMessage(null)).toBeNull();
  });
});
