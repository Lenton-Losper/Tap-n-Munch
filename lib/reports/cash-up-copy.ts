/**
 * EVERY STRING PRINTED ON THE CASH-UP SLIP.
 *
 * ================================================================================================
 * WHY THESE LIVE IN THE WEB REPO
 * ================================================================================================
 *
 * The cash-up document is rendered SERVER-SIDE — the terminal receives ESC/POS bytes and SDK6
 * lines already composed and pushes them at a printer. So the words on the paper are decided here,
 * not on the device. The terminal's own signed copy (src/constants/cashUpCopy.ts over there) is
 * the SCREEN a manager touches; this is the paper that comes out.
 *
 * They were inline literals in cash-up-document.ts until 2026-09-06, which meant the strings a
 * venue hands to someone were changeable by anyone editing a renderer, with nothing to notice.
 *
 * SIGNED BY THE OWNER 2026-09-06. Pinned in __tests__/cash-up-copy-signed-off.test.ts.
 *
 * ================================================================================================
 * NOT_A_TAX_INVOICE IS THE ONE THAT MATTERS
 * ================================================================================================
 *
 * Owner at signing: "A document showing the day's takings with a venue name on it is exactly the
 * thing someone might present as a receipt, and the line saying it isn't one shouldn't be quietly
 * rewordable."
 *
 * FlashTap issues real tax invoices and real receipts, with RCT numbering, a VAT number and an
 * outlet block. This slip has a venue name, a date and money on it and NONE of that. Removing or
 * softening this line is how it gets handed to a customer, or filed as if it were one.
 */

/** The document's own name, at the top, centred. */
export const CASH_UP_HEADING = 'CASH-UP';

/** Section: what came in and how it was paid. */
export const CASH_UP_TAKINGS_HEADING = 'TAKINGS';

/** Section: tips, printed BELOW the total and never inside it. */
export const CASH_UP_GRATUITIES_HEADING = 'GRATUITIES';

/** Section: what went out of the kitchen, uncapped. */
export const CASH_UP_ITEMS_HEADING = 'ITEMS SOLD';

/**
 * The bridge from the parts to the headline. The split is gross of refunds and the revenue figure
 * is net of them, so these three lines are what stop the slip reading as an arithmetic error to
 * the person counting the drawer.
 */
export const CASH_UP_GROSS_TAKEN = 'Gross taken';
export const CASH_UP_LESS_REFUNDS = 'Less refunds';
export const CASH_UP_NET_REVENUE = 'Net revenue';

/** The order count behind the figures above. */
export const CASH_UP_ORDERS = 'Orders';

/** Said under the gratuity figure, so nobody adds it to the takings by eye. */
export const CASH_UP_GRATUITIES_NOTE = 'Not part of takings above.';

/** A period with no payments at all. A real answer, never an empty section. */
export const CASH_UP_NO_PAYMENTS = 'No payments recorded';

/** A period in which nothing left the kitchen. */
export const CASH_UP_NOTHING_SOLD = 'Nothing sold';

/** Carries {name}: WHO printed it, never which device. The PIN exists to put a name here. */
export const CASH_UP_PRINTED_BY = 'Printed by {name}';

/**
 * THE DISCLAIMER. See the header — this is the line that stops a takings slip being presented or
 * filed as a receipt. It must stay on the paper and must stay this blunt.
 */
export const CASH_UP_NOT_A_TAX_INVOICE = 'Not a tax invoice.';
