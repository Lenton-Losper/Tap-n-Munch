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
  SPLIT_CARD_BY_ITEM_NOT_ENABLED,
  SPLIT_CARD_CHARGED_NOT_RECORDED,
  SPLIT_CARD_DECLINED,
  SPLIT_CARD_HOLD_UNKNOWN,
  SPLIT_CARD_ITEMS_GONE,
  SPLIT_CARD_ITEMS_HELD,
  SPLIT_CARD_NOT_SET_UP,
  SPLIT_CARD_NOT_STARTED,
  SPLIT_CARD_NOTHING_TO_CHARGE,
  SPLIT_CARD_OUTCOME_NOT_RECORDED,
  SPLIT_CARD_PAID,
  SPLIT_CARD_PENDING_BODY,
  SPLIT_CARD_TABLE_OUT_OF_DATE,
  SPLIT_CARD_TERMINAL_NOT_ALLOWED,
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
 * WHICH HALF OF THE PAYMENT A FAILURE HAPPENED IN.
 *
 * The only fact that decides what a waiter must be told, so it is a parameter rather than
 * something inferred from an error.
 *
 *   'prepare'  the reader has NOT been launched. Nothing has been charged, and cash is safe.
 *   'record'   the reader HAS run. The customer may be holding a receipt; cash is not safe and
 *              neither is charging again.
 */
export type SplitCardPhase = 'prepare' | 'record';

/** Server code -> signed string. Every code either route can emit appears here. */
const CODE_MESSAGES: Record<string, string> = {
  // Prepare side.
  MISSING_PERMISSION: SPLIT_CARD_TERMINAL_NOT_ALLOWED,
  STATION_SCREENS_DISABLED: SPLIT_CARD_BY_ITEM_NOT_ENABLED,
  BAD_TAB_ID: SPLIT_CARD_TABLE_OUT_OF_DATE,
  INVALID_ALLOCATION_ID: SPLIT_CARD_TABLE_OUT_OF_DATE,
  ITEMS_READ_FAILED: SPLIT_CARD_TABLE_OUT_OF_DATE,
  NO_ALLOCATIONS: SPLIT_CARD_NOTHING_TO_CHARGE,
  NOT_CHARGEABLE: SPLIT_CARD_NOTHING_TO_CHARGE,
  NO_FINATIC_CREDENTIALS: SPLIT_CARD_NOT_SET_UP,
  ALLOCATION_NOT_ON_TAB: SPLIT_CARD_ITEMS_GONE,
  ALLOCATION_NOT_PAYABLE: SPLIT_CARD_ITEMS_GONE,
  HOLD_CHECK_FAILED: SPLIT_CARD_HOLD_UNKNOWN,
  ITEMS_HELD_BY_CARD: SPLIT_CARD_ITEMS_HELD,
  PREPARE_FAILED: SPLIT_CARD_NOT_STARTED,

  // Record side. The reader has already run for every one of these.
  RECORD_BAD_TAB_ID: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  NO_REFERENCE: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  INTENT_LOOKUP_FAILED: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  NO_INTENT: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  WRONG_SCOPE: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  RECORD_FAILED: SPLIT_CARD_OUTCOME_NOT_RECORDED,
  SETTLEMENT_FAILED_AFTER_CHARGE: SPLIT_CARD_CHARGED_NOT_RECORDED,
};

/**
 * THE SIGNED STRING FOR A FAILURE. ALWAYS A SIGNED STRING -- there is no path out of here that
 * shows a waiter anything else.
 *
 * ================================================================================================
 * WHY THIS NO LONGER RETURNS null
 * ================================================================================================
 *
 * It used to, and the caller ended its lookup with `?? err.message`. That is how "Missing
 * permission" -- a string written for a server log -- was read off a card machine at Digi Cofee on
 * 2026-09-08. The fallback was meant as a safety net and was a hole: it guaranteed that every
 * refusal nobody had thought about reached a customer-facing screen in a server author's words.
 *
 * SEVENTEEN of the two routes' twenty-two refusal sites went out that way -- seven carried no code
 * at all and ten carried a code nothing mapped.
 *
 * ================================================================================================
 * AN UNKNOWN FAILURE FALLS BACK BY PHASE, NOT TO RAW TEXT
 * ================================================================================================
 *
 * A failure with no code, or a code from a build newer than this one, still has to say something
 * true. The phase is enough to be both honest and safe:
 *
 *   prepare -> "nothing was charged" is true of EVERY prepare-side failure, because the reader has
 *              not been launched. Cash is offered.
 *   record  -> "may have been charged" is true of EVERY record-side failure, because the reader
 *              has run. Cash and re-charging are both forbidden.
 *
 * This is also what covers the case no error code can describe: the request never reaching the
 * server at all. A dropped connection after the reader answered is precisely the state
 * SPLIT_CARD_OUTCOME_NOT_RECORDED exists for.
 *
 * The coverage lock-test asserts every code either route can emit is in CODE_MESSAGES, so the
 * phase fallback is a genuine backstop rather than the ordinary path.
 */
export function splitCardFailureMessage(code: string | null, phase: SplitCardPhase): string {
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code];
  }
  return phase === 'record' ? SPLIT_CARD_OUTCOME_NOT_RECORDED : SPLIT_CARD_NOT_STARTED;
}

/** The codes this build maps. Read by the coverage test; not used at runtime. */
export const MAPPED_SPLIT_CARD_CODES = Object.keys(CODE_MESSAGES);

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
