/**
 * WHICH DEVICE OUTCOME BECOMES WHICH RESOLUTION.
 *
 * The single decision in this feature where being wrong costs a customer money in both directions:
 * too eager to call it failed releases items they may have paid for; too eager to call it success
 * marks items paid that were not.
 *
 * E04111 from this gateway means NO RECORD, never NOT PAID — so "we did not get a yes" is not "the
 * customer was not charged", and only a CONFIRMED refusal may become 'failed'.
 */
import {
  itemsStateForStatus,
  mustNotOfferPaymentAgain,
  outcomeForDeviceResult,
  splitCardFailureMessage,
  splitCardResultMessage,
} from '../splitCardPayment';
import * as Copy from '../../constants/splitCardCopy';
import type {PaymentResult} from '../payment';

const r = (over: Partial<PaymentResult>): PaymentResult =>
  ({success: false, ...over}) as PaymentResult;

describe('only a confirmed refusal becomes failed', () => {
  it('a confirmed success is success', () => {
    expect(outcomeForDeviceResult(r({success: true, outcomeKind: 'success'}))).toBe('success');
  });

  it('a confirmed failure is failed — nothing can land later', () => {
    expect(outcomeForDeviceResult(r({outcomeKind: 'confirmed_failure'}))).toBe('failed');
  });

  it('a user cancel is failed — no card was ever presented', () => {
    expect(outcomeForDeviceResult(r({outcomeKind: 'user_cancelled'}))).toBe('failed');
  });

  it('AMBIGUOUS is uncertain, never failed', () => {
    // The whole point. The gateway may still answer yes.
    expect(outcomeForDeviceResult(r({outcomeKind: 'ambiguous'}))).toBe('uncertain');
    expect(outcomeForDeviceResult(r({outcomeKind: 'orphaned_ambiguous'}))).toBe('uncertain');
  });

  it('an ORPHANED SUCCESS is uncertain too, not success', () => {
    /**
     * Strong evidence, but it is a callback this app found after the fact rather than the reader
     * answering us. Held is the safe reading and the webhook confirms it — marking it paid here
     * would settle items on the device's own inference.
     */
    expect(outcomeForDeviceResult(r({success: true, outcomeKind: 'orphaned_success'}))).toBe(
      'uncertain',
    );
  });

  it('an unrecognised outcome is uncertain', () => {
    // A kind added later, or a truncated result. Not evidence of anything.
    expect(outcomeForDeviceResult(r({outcomeKind: undefined}))).toBe('uncertain');
    expect(outcomeForDeviceResult(r({success: true, outcomeKind: undefined}))).toBe('uncertain');
  });
});

describe('what each resolution does to the items', () => {
  it('confirmed pays, failed frees, uncertain holds', () => {
    expect(itemsStateForStatus('confirmed')).toBe('paid');
    expect(itemsStateForStatus('failed')).toBe('free');
    expect(itemsStateForStatus('uncertain')).toBe('held');
  });

  it('ONLY uncertain closes off taking the money again', () => {
    /**
     * The predicate the UI hangs on. A held item must offer no route to charging the customer a
     * second time — the server refuses it, and this stops a waiter reaching that refusal with a
     * customer watching.
     */
    expect(mustNotOfferPaymentAgain('uncertain')).toBe(true);
    expect(mustNotOfferPaymentAgain('failed')).toBe(false);
    expect(mustNotOfferPaymentAgain('confirmed')).toBe(false);
  });
});

describe('what the waiter is told', () => {
  it('each resolution gets its signed string', () => {
    expect(splitCardResultMessage('confirmed')).toBe(Copy.SPLIT_CARD_PAID);
    expect(splitCardResultMessage('failed')).toBe(Copy.SPLIT_CARD_DECLINED);
    expect(splitCardResultMessage('uncertain')).toBe(Copy.SPLIT_CARD_PENDING_BODY);
  });

  it('every server refusal maps to a signed string', () => {
    const cases: Array<[string, string]> = [
      ['ITEMS_HELD_BY_CARD', Copy.SPLIT_CARD_ITEMS_HELD],
      ['ALLOCATION_NOT_PAYABLE', Copy.SPLIT_CARD_ITEMS_GONE],
      ['ALLOCATION_NOT_ON_TAB', Copy.SPLIT_CARD_ITEMS_GONE],
      ['NO_FINATIC_CREDENTIALS', Copy.SPLIT_CARD_NOT_SET_UP],
      ['SETTLEMENT_FAILED_AFTER_CHARGE', Copy.SPLIT_CARD_CHARGED_NOT_RECORDED],
      ['MISSING_PERMISSION', Copy.SPLIT_CARD_TERMINAL_NOT_ALLOWED],
      ['STATION_SCREENS_DISABLED', Copy.SPLIT_CARD_BY_ITEM_NOT_ENABLED],
      ['BAD_TAB_ID', Copy.SPLIT_CARD_TABLE_OUT_OF_DATE],
      ['INVALID_ALLOCATION_ID', Copy.SPLIT_CARD_TABLE_OUT_OF_DATE],
      ['ITEMS_READ_FAILED', Copy.SPLIT_CARD_TABLE_OUT_OF_DATE],
      ['NO_ALLOCATIONS', Copy.SPLIT_CARD_NOTHING_TO_CHARGE],
      ['NOT_CHARGEABLE', Copy.SPLIT_CARD_NOTHING_TO_CHARGE],
      ['HOLD_CHECK_FAILED', Copy.SPLIT_CARD_HOLD_UNKNOWN],
      ['PREPARE_FAILED', Copy.SPLIT_CARD_NOT_STARTED],
      ['RECORD_BAD_TAB_ID', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
      ['NO_REFERENCE', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
      ['INTENT_LOOKUP_FAILED', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
      ['NO_INTENT', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
      ['WRONG_SCOPE', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
      ['RECORD_FAILED', Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED],
    ];
    for (const [code, expected] of cases) {
      // The phase is irrelevant for a code that maps -- asserted with the WRONG one deliberately,
      // so a mapping quietly falling through to the phase fallback shows up here.
      expect({code, msg: splitCardFailureMessage(code, 'prepare')}).toEqual({code, msg: expected});
      expect({code, msg: splitCardFailureMessage(code, 'record')}).toEqual({code, msg: expected});
    }
  });

  it('NEVER returns raw server text -- an unknown code falls back BY PHASE', () => {
    /**
     * The defect this replaced: the screen ended its lookup with `?? err.message`, so a waiter at
     * Digi Cofee read "Missing permission" -- a string written for a server log -- off a card
     * machine. There must be no path out of here that is not signed copy.
     *
     * The phase is enough to be honest. Before the reader runs, nothing has been charged. After it
     * runs, something may have been.
     */
    expect(splitCardFailureMessage('SOMETHING_NEW', 'prepare')).toBe(Copy.SPLIT_CARD_NOT_STARTED);
    expect(splitCardFailureMessage(null, 'prepare')).toBe(Copy.SPLIT_CARD_NOT_STARTED);
    expect(splitCardFailureMessage('SOMETHING_NEW', 'record')).toBe(
      Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED,
    );
    expect(splitCardFailureMessage(null, 'record')).toBe(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED);
  });

  it('a record-phase unknown NEVER offers cash, and a prepare-phase one does', () => {
    /**
     * The load-bearing contrast in the whole set, asserted on the fallbacks specifically -- those
     * are the ones reached when nobody planned for the failure, which is exactly when a waiter is
     * most likely to improvise.
     */
    expect(splitCardFailureMessage(null, 'record')).toMatch(/do not take cash/i);
    expect(splitCardFailureMessage(null, 'record')).toMatch(/do not charge again/i);
    expect(splitCardFailureMessage(null, 'prepare')).toMatch(/take cash/i);
    expect(splitCardFailureMessage(null, 'prepare')).not.toMatch(/do not take cash/i);
  });

  it('the held message is never shown for a decline, and vice versa', () => {
    // Confusing the two is how a waiter takes cash for items a card may have paid for.
    expect(splitCardResultMessage('uncertain')).not.toBe(splitCardResultMessage('failed'));
  });
});
