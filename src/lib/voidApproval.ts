/**
 * TAKING FOOD OFF A BILL: THE RULES, WITHOUT THE SCREEN.
 *
 * ================================================================================================
 * WHAT COUNTS AS A VOID
 * ================================================================================================
 *
 * ANY REDUCTION, not just a removal. `new_quantity = 0` is the obvious one, but 3 to 1 writes two
 * dishes off the bill just as surely, and gating only zero leaves a bypass a waiter finds in a
 * week. The server gates on exactly this test (app/api/terminal/tabs/[tabId]/amend/route.ts) and
 * this file exists so the screen asks for the PIN in precisely the cases the server will demand
 * one — a screen that gates differently is a waiter telling a customer an item is off and finding
 * out afterwards that it is not.
 *
 * AN INCREASE IS NOT A VOID. It adds to what the customer owes. Nothing to approve.
 *
 * ================================================================================================
 * THESE ARE AFFORDANCES. THE SERVER IS THE AUTHORITY.
 * ================================================================================================
 *
 * Nothing here authorises anything. `voidApprovalComplete` decides whether the Approve button is
 * pressable; the PIN is exchanged for a single-use token by the server, and the server consumes it
 * again on the amend. A build that skipped all of this would be refused with
 * VOID_NEEDS_AUTHORIZATION, which is why that string exists.
 */
import {
  AMEND_EFFECT_CHANGE,
  AMEND_EFFECT_REMOVE,
} from '../constants/amendCopy';
import {
  VOID_EFFECT_REDUCE,
  VOID_EFFECT_REDUCE_ONE,
  VOID_NEEDS_AUTHORIZATION,
  VOID_NEEDS_REASON,
  VOID_REASON_TOO_LONG,
  VOID_REFUSED_PIN,
} from '../constants/voidCopy';

/** What the waiter has filled in so far. Not an authorisation — see the header. */
export type VoidApprovalDraft = {
  staffUserId: string;
  name: string;
  pin: string;
  reason: string;
};

/**
 * The shortest reason worth storing. Somebody reconciling a bill next week reads this column, and
 * "x" tells them nothing; three characters is the cheapest test that rejects a stray keypress
 * without turning into a writing exercise at a table.
 */
export const MIN_VOID_REASON_LENGTH = 3;

/** The server's own limit (MAX_VOID_REASON_LENGTH), so the field stops before the request does. */
export const MAX_VOID_REASON_LENGTH = 280;

/**
 * ANY reduction, mirroring the server. Non-finite input is NOT a reduction: an unknown quantity
 * must not silently become a void, and the server refuses the line anyway.
 */
export function isReduction(current: number, next: number): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(next)) {
    return false;
  }
  return next < current;
}

/** Whether the Approve button may be pressed. Whitespace is not a PIN and is not a reason. */
export function voidApprovalComplete(draft: VoidApprovalDraft | null): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.staffUserId.trim().length > 0 &&
    draft.pin.trim().length > 0 &&
    draft.reason.trim().length >= MIN_VOID_REASON_LENGTH &&
    draft.reason.trim().length <= MAX_VOID_REASON_LENGTH
  );
}

/**
 * The sentence under the stepper. A quantity change that takes food OFF has to say so in money
 * terms; AMEND_EFFECT_CHANGE describes what the kitchen sees and would let a waiter approve a
 * write-off having read nothing about the bill.
 */
export function reductionEffect(current: number, next: number): string {
  if (!isReduction(current, next)) {
    return AMEND_EFFECT_CHANGE;
  }
  if (next === 0) {
    return AMEND_EFFECT_REMOVE;
  }
  const removed = current - next;
  return removed === 1
    ? VOID_EFFECT_REDUCE_ONE
    : VOID_EFFECT_REDUCE.replace('{count}', String(removed));
}

/**
 * The server's refusal codes, in the words a waiter reads.
 *
 * EVERY ONE OF THESE MEANS NOTHING CHANGED, and every string says so, because the waiter has
 * already told the customer the item is coming off. `null` for anything unrecognised so the caller
 * keeps its own fallback rather than this inventing one.
 */
export function voidFailureMessage(code: string | null): string | null {
  switch (code) {
    case 'AUTHORIZATION_INVALID':
    case 'AUTHORIZATION_REQUIRED':
      return VOID_REFUSED_PIN;
    case 'VOID_NEEDS_AUTHORIZATION':
      return VOID_NEEDS_AUTHORIZATION;
    case 'VOID_NEEDS_REASON':
      return VOID_NEEDS_REASON;
    case 'VOID_REASON_TOO_LONG':
      return VOID_REASON_TOO_LONG;
    default:
      return null;
  }
}
