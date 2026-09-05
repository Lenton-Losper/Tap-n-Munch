/**
 * THE GRATUITY PICKER.
 *
 * ============================================================================================
 * SIGNED BY THE OWNER 2026-09-05. Pinned as written.
 * ============================================================================================
 *
 * Every string here is shown to a waiter at a table with a customer waiting, which is why they
 * were signed before any binary. The lock test (gratuityCopySignedOff.test.ts) is written against
 * these exact strings so a later edit cannot slip through unnoticed.
 *
 * SIGNED WITH ONE CHANGE, on GRATUITY_NO_STAFF -- see the comment on it.
 *
 * ============================================================================================
 * WHAT THIS SURFACE IS, AND WHAT IT IS NOT
 * ============================================================================================
 *
 * It is ATTRIBUTION: which member of staff is taking this gratuity. Nobody is approving anything
 * and nothing is proved -- ANYONE HOLDING THE TERMINAL CAN PICK ANYONE. That is acceptable for a
 * gratuity, where a mis-tap is a payroll correction.
 *
 * It is NOT AUTHORISATION. A refund, a cash settlement and a walkout close each write away money
 * or debt, and each keeps its PIN. THIS PATTERN MUST NOT BE REUSED FOR THEM.
 *
 * So none of the copy below says "verified", "authorised" or "approved". Those words would be
 * false here, and would invite exactly that reuse. There is a test that keeps them out.
 */

/** The section heading, shown only once a gratuity amount has been keyed. */
export const GRATUITY_PICKER_HEADING = 'Who is taking this gratuity?';

/**
 * The pre-selected row, when the table has a live assignment. {name} is the waiter.
 *
 * The common case is CONFIRM, not choose: the person who owns the table is almost always the
 * person taking the tip, so the picker opens with them already selected and the waiter only acts
 * if it is wrong.
 */
export const GRATUITY_ASSIGNED_HINT = 'Assigned to this table';

/** The affordance that opens the full list when the pre-selection is wrong. */
export const GRATUITY_CHANGE = 'Change';

/** The unselected state, when the table has no live assignment. */
export const GRATUITY_CHOOSE = 'Choose a staff member';

/**
 * No staff records at all for this venue.
 *
 * THE OWNER'S EDIT, 2026-09-05. Proposed as "No staff members are set up for this venue, so a
 * gratuity cannot be recorded against anyone. Add staff in Settings, or settle without one."
 *
 * "Settle without one" reads, mid-service, as a harmless option -- and the customer may already
 * have agreed to a tip. What is being given up is that tip, so the copy says so. Shorter and it
 * names the loss.
 */
export const GRATUITY_NO_STAFF =
  'No staff members are set up for this venue. Add staff in Settings, or settle without a gratuity.';

/**
 * Blocking validation: a gratuity is keyed and nobody is chosen.
 *
 * The charge button is disabled alongside this, so the sentence is the reason and not a warning
 * about something that will happen anyway.
 */
export const GRATUITY_NEEDS_STAFF = 'Choose who is taking this gratuity.';

/**
 * The collapsed entry point. NO GRATUITY IS THE COMMON CASE AND STAYS ONE TAP: a waiter taking
 * none never touches this, and the payment buttons behave exactly as they did before it existed.
 */
export const GRATUITY_ADD = '+ Add gratuity';

/** The amount field's label, once opened. */
export const GRATUITY_AMOUNT_LABEL = 'Gratuity';

/** Backs out of an opened gratuity entirely — clears the amount and the chosen staff member. */
export const GRATUITY_REMOVE = 'Remove';
