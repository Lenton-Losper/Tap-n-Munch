/**
 * EVERY STRING THE VARIANT PICKER SHOWS -- on a POS sale and inside the Add-a-Round item sheet.
 *
 * Added for the Sprint 2026-09-28 brief ("display available variants, allow selecting, send the
 * selected variant identity, display selected variant, display correct variant price").
 *
 * DRAFTED, NOT YET SIGNED. Written to the house style of the 37 strings the owner signed on
 * 2026-08-28: say what happens, plain words a waiter uses, on money say the consequence and what to
 * do, short on buttons. Needs the owner's signature before it is pinned like roundItemSheetCopy.
 */

/** Beside a group's name when it must be answered. */
export const VARIANT_REQUIRED_TAG = 'Required';

/** Beside a group's name when it may be skipped. */
export const VARIANT_OPTIONAL_TAG = 'Optional';

/**
 * Where the price would be while a required choice is still open. Says what to do rather than
 * showing a base price the server will never charge (N$0.00 on a zero-base item).
 */
export const VARIANT_CHOOSE_TO_SEE_PRICE = 'Choose {groups} to see the price';

/** The POS picker's confirm. */
export const VARIANT_ADD_TO_SALE = 'Add to sale';

/** Leaves the POS picker. Says the consequence, like the round sheet's cancel. */
export const VARIANT_CANCEL = 'Cancel — nothing added';

/**
 * A C5 refusal from the server (MENU_ITEM_VARIANT_REQUIRED / MENU_ITEM_UNPRICEABLE_SELECTION):
 * the menu changed under the device, or an older menu listing had no options. Nothing was charged.
 */
export const VARIANT_REFUSED_TITLE = 'Choose options again';
export const VARIANT_REFUSED_SUFFIX =
  'Nothing was charged. Remove the item, add it again and choose its options.';
