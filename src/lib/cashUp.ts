/**
 * THE CASH-UP'S RULES, WITHOUT THE SCREEN.
 *
 * Pure, so the conditions the button depends on can be tested without rendering, and so the screen
 * has one place to be wrong rather than several.
 *
 * NOTHING HERE AUTHORISES ANYTHING. `cashUpReady` decides whether the Print button is pressable;
 * the PIN is exchanged for a single-use token by the server, and the server consumes it again when
 * the report is built. A build that skipped all of this is refused with
 * CASH_UP_NEEDS_AUTHORIZATION, which is why that string exists.
 */
import {
  CASH_UP_NEEDS_AUTHORIZATION,
  CASH_UP_PRINTER_FAILED,
  CASH_UP_REFUSED_PIN,
  CASH_UP_REPORT_FAILED,
} from '../constants/cashUpCopy';

/** Who is printing, and the code they have typed. Not an authorisation — see the header. */
export type CashUpDraft = {
  staffUserId: string;
  name: string;
  pin: string;
};

/** Whether the Print button may be pressed. Whitespace is not a PIN. */
export function cashUpReady(draft: CashUpDraft | null): boolean {
  if (!draft) {
    return false;
  }
  return draft.staffUserId.trim().length > 0 && draft.pin.trim().length > 0;
}

/**
 * The server's refusal codes, in the words a manager reads.
 *
 * EVERY ONE OF THESE MEANS NOTHING PRINTED, and every string says so. A manager who cannot tell
 * whether the slip came out prints it again and then has two pieces of paper and no idea which is
 * right.
 *
 * `null` for anything unrecognised, so the caller keeps its own fallback rather than this
 * inventing wording nobody signed.
 */
export function cashUpFailureMessage(code: string | null): string | null {
  switch (code) {
    case 'AUTHORIZATION_INVALID':
    case 'AUTHORIZATION_REQUIRED':
    case 'PIN_MISMATCH':
      return CASH_UP_REFUSED_PIN;
    case 'CASH_UP_NEEDS_AUTHORIZATION':
      return CASH_UP_NEEDS_AUTHORIZATION;
    case 'INVALID_PRESET':
      // The screen offers exactly the three the server accepts, so this means the two sides
      // disagree — a build/deploy mismatch, not something the manager did.
      return CASH_UP_REPORT_FAILED;
    case 'PRINT_FAILED':
    case 'CASH_UP_FORMAT_UNAVAILABLE':
      return CASH_UP_PRINTER_FAILED;
    default:
      return null;
  }
}
