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
    expect(splitCardFailureMessage('ITEMS_HELD_BY_CARD')).toBe(Copy.SPLIT_CARD_ITEMS_HELD);
    expect(splitCardFailureMessage('ALLOCATION_NOT_PAYABLE')).toBe(Copy.SPLIT_CARD_ITEMS_GONE);
    expect(splitCardFailureMessage('ALLOCATION_NOT_ON_TAB')).toBe(Copy.SPLIT_CARD_ITEMS_GONE);
    expect(splitCardFailureMessage('NO_FINATIC_CREDENTIALS')).toBe(Copy.SPLIT_CARD_NOT_SET_UP);
    expect(splitCardFailureMessage('SETTLEMENT_FAILED_AFTER_CHARGE')).toBe(
      Copy.SPLIT_CARD_CHARGED_NOT_RECORDED,
    );
  });

  it('hands an unknown code back rather than inventing wording', () => {
    expect(splitCardFailureMessage('SOMETHING_NEW')).toBeNull();
    expect(splitCardFailureMessage(null)).toBeNull();
  });

  it('the held message is never shown for a decline, and vice versa', () => {
    // Confusing the two is how a waiter takes cash for items a card may have paid for.
    expect(splitCardResultMessage('uncertain')).not.toBe(splitCardResultMessage('failed'));
  });
});
