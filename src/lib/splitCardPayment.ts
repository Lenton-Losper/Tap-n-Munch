/**
 * PART-ORDER CARD PAYMENT — the rules, without the screen.
 *
 * Pure, so the two decisions that matter can be tested without a reader and without rendering:
 *
 *   1. WHICH DEVICE OUTCOME BECOMES WHICH RESOLUTION. Getting this wrong in the failed direction
 *      releases items the customer may have paid for; getting it wrong in the success direction
 *      marks items paid that were not.
 *   2. WHAT A WAITER IS TOLD. Each server refusal maps to one signed string, and every one of them
 *      says what to do — because the move a waiter invents when told only "no" is cash.
 */
import {
  SPLIT_CARD_CHARGED_NOT_RECORDED,
  SPLIT_CARD_DECLINED,
  SPLIT_CARD_ITEMS_GONE,
  SPLIT_CARD_ITEMS_HELD,
  SPLIT_CARD_NOT_SET_UP,
  SPLIT_CARD_PAID,
  SPLIT_CARD_PENDING_BODY,
} from '../constants/splitCardCopy';
import type {PaymentResult} from './payment';
import type {SplitPaymentOutcome} from './api';

/**
 * The device's outcome vocabulary, collapsed to the three the server understands.
 *
 * ONLY A CONFIRMED GATEWAY REFUSAL BECOMES 'failed'. Everything else that is not a confirmed
 * success is 'uncertain' — an ambiguous result, an orphaned callback, a timeout, a result code this
 * build has never seen. E04111 from this gateway means NO RECORD, never NOT PAID, so "we did not
 * get a yes" is not "the customer was not charged".
 *
 * A user cancel is the one non-success that IS a confirmed refusal: the customer never presented a
 * card, so nothing can land later.
 */
export function outcomeForDeviceResult(result: PaymentResult): SplitPaymentOutcome {
  if (result.success && result.outcomeKind === 'success') {
    return 'success';
  }
  if (result.outcomeKind === 'confirmed_failure' || result.outcomeKind === 'user_cancelled') {
    return 'failed';
  }
  // 'ambiguous', 'orphaned_ambiguous', 'orphaned_success', and anything added later.
  //
  // NOTE 'orphaned_success' IS DELIBERATELY HERE AND NOT ABOVE. An orphaned callback is a result
  // this app found after the fact rather than one it watched arrive; it is strong evidence and it
  // is not the reader answering us. Held is the safe reading, and the webhook confirms it.
  return 'uncertain';
}

/** Whether a resolution leaves the items paid, held, or free. */
export function itemsStateForStatus(
  status: 'confirmed' | 'failed' | 'uncertain',
): 'paid' | 'held' | 'free' {
  if (status === 'confirmed') return 'paid';
  if (status === 'failed') return 'free';
  return 'held';
}

/**
 * The signed string for a server refusal.
 *
 * `null` for anything unrecognised, so the caller keeps its own fallback rather than this inventing
 * wording nobody signed.
 */
export function splitCardFailureMessage(code: string | null): string | null {
  switch (code) {
    case 'ITEMS_HELD_BY_CARD':
      return SPLIT_CARD_ITEMS_HELD;
    case 'ALLOCATION_NOT_PAYABLE':
    case 'ALLOCATION_NOT_ON_TAB':
      return SPLIT_CARD_ITEMS_GONE;
    case 'NO_FINATIC_CREDENTIALS':
      return SPLIT_CARD_NOT_SET_UP;
    case 'SETTLEMENT_FAILED_AFTER_CHARGE':
      return SPLIT_CARD_CHARGED_NOT_RECORDED;
    default:
      return null;
  }
}

/** What to show once a charge resolves. */
export function splitCardResultMessage(
  status: 'confirmed' | 'failed' | 'uncertain',
): string {
  if (status === 'confirmed') return SPLIT_CARD_PAID;
  if (status === 'failed') return SPLIT_CARD_DECLINED;
  return SPLIT_CARD_PENDING_BODY;
}

/**
 * Is this a state where the waiter must NOT be offered a way to take the money again?
 *
 * The single most important predicate in the feature. `held` means the customer may already have
 * paid, so every route to charging them again — cash, another card — has to be closed off in the
 * UI as well as refused by the server. Belt and braces, deliberately: the server refusal is what
 * makes it safe, and this is what stops a waiter reaching the refusal with a customer watching.
 */
export function mustNotOfferPaymentAgain(
  status: 'confirmed' | 'failed' | 'uncertain',
): boolean {
  return status === 'uncertain';
}
