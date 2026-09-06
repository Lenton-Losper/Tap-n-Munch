/**
 * EVERY STRING ON THE CASH-UP SCREEN.
 *
 * Drafted by me under the owner's standing instruction to draft rather than ask. Nothing here is
 * a PENDING COPY placeholder. If a string reads wrong, say so and it changes.
 *
 * House style, from the 37 the owner signed on 2026-08-28:
 *   say what happens, not what the thing is; plain words a waiter uses; on money or food safety
 *   say the consequence AND what to do; never imply something is settled when it is not; a success
 *   must not read like a warning; say where, not just what; short on buttons, full sentences where
 *   it matters.
 *
 * ================================================================================================
 * WHO READS THESE
 * ================================================================================================
 *
 * A manager closing up, at the end of a shift, with the drawer open. Not a waiter mid-service.
 * The tone can be slower than the service screens, but every refusal still has to say whether
 * anything printed — a manager who does not know whether the slip came out will print it twice
 * and then wonder which one is right.
 *
 * SIGNED: pending.
 */

/** The screen. Named for what it produces, not for the report it runs. */
export const CASH_UP_TITLE = 'Cash-up';

/**
 * Under the title. Says what the paper will contain, because the manager is about to hand a PIN
 * over for it, and says the one thing it is not.
 */
export const CASH_UP_INTRO =
  'Prints the takings for a period: cash and card, what was sold, and any gratuities. It is not a tax invoice.';

/** Above the three period buttons. */
export const CASH_UP_PERIOD_LABEL = 'Which period?';

/**
 * The three periods. These are the only ones offered on the terminal, deliberately — see the
 * route. The labels match the server's, so the paper and the screen agree.
 */
export const CASH_UP_PERIOD_TODAY = 'Today';
export const CASH_UP_PERIOD_YESTERDAY = 'Yesterday';
export const CASH_UP_PERIOD_THIS_WEEK = 'This week';

/**
 * Says where a longer period comes from. Without it, a manager who wants last month concludes the
 * feature is broken rather than that it lives somewhere else.
 */
export const CASH_UP_PERIOD_HINT =
  'For any other dates, use Order History on the dashboard.';

/** Above the manager chips. A question, because they are about to point at somebody. */
export const CASH_UP_PICK_MANAGER = 'Who is printing this?';

/** Carries {name} so the terminal goes to the right person rather than whoever is holding it. */
export const CASH_UP_PIN_PROMPT = "{name}'s PIN";

/**
 * Why a PIN is being asked for at all. A manager who thinks it is a hoop will share the code; one
 * who knows their name goes on the paper will not.
 */
export const CASH_UP_PIN_REASON =
  'The takings are only shown to a manager or owner, and the name goes on the printout.';

/** The button. Says what it does. */
export const CASH_UP_PRINT = 'Print cash-up';

/** While the report is being built and sent to the printer. */
export const CASH_UP_PRINTING = 'Printing…';

/**
 * Nobody at this venue can authorise one. Says what to do, and does not pretend the printout is
 * available in the meantime.
 */
export const CASH_UP_NO_MANAGERS =
  'Nobody here can print the cash-up. A manager or owner has to be added in Settings first.';

/**
 * The PIN was wrong, OR it belongs to somebody without the permission. Both mean the same thing to
 * the person holding the terminal, and saying which would tell them something about a PIN that is
 * not theirs.
 */
export const CASH_UP_REFUSED_PIN =
  'That PIN was not accepted, so nothing was printed. Check who is printing it and try again.';

/**
 * Server code CASH_UP_NEEDS_AUTHORIZATION (403). Reached when a build that does not ask for a PIN
 * talks to a server that requires one.
 */
export const CASH_UP_NEEDS_AUTHORIZATION =
  'This terminal needs updating before it can print a cash-up. Nothing was printed.';

/** The report was built but the printer would not take it. Says the report itself was fine. */
export const CASH_UP_PRINTER_FAILED =
  'The cash-up was ready but the printer did not take it. Check the paper and try again — nothing has been recorded either way.';

/** No printer set up on this terminal at all. */
export const CASH_UP_NO_PRINTER =
  'No printer is set up on this terminal. Set one up in Settings, then try again.';

/** The report could not be built — a network or server failure, not a printer one. */
export const CASH_UP_REPORT_FAILED =
  'The cash-up could not be worked out just now. Nothing was printed. Try again in a moment.';

/**
 * It worked. A success must not read like a warning: no "please check", no hedging.
 */
export const CASH_UP_PRINTED = 'Cash-up printed.';

/**
 * A period with no trade at all. Said on screen rather than left to the paper, because a manager
 * who prints a blank slip checks the printer rather than believing the number.
 */
export const CASH_UP_NOTHING_TAKEN =
  'Nothing was taken in that period. The printout will say so.';
