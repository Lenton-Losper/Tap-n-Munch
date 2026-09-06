/**
 * EVERY STRING ON THE ITEM SHEET — the one a waiter gets when they tap something on the menu.
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
 * IT COPIES THE CUSTOMER'S SHEET, ON PURPOSE
 * ================================================================================================
 *
 * The QR item sheet (web: components/menu/item-detail-modal.tsx) already asks a customer for a
 * quantity and a note before the item joins the basket. This is the same interaction for the
 * waiter, so the two halves of the venue think about an item the same way, and so a note lands at
 * the moment somebody is deciding it rather than on a row afterwards.
 *
 * WHAT IT DELIBERATELY DOES NOT COPY: variants, sizes and add-ons. The round flow has never
 * modelled them — a RoundLine is item, quantity, note and nothing else — and building that to
 * mirror a sheet would be the wrong order. Owner's ruling, 2026-09-06.
 *
 * SIGNED: pending.
 */

/**
 * The note field. Says who reads it, because "note" alone gets used for things the kitchen will
 * never see, and gives the example that makes the per-unit case obvious.
 */
export const ITEM_SHEET_NOTE_LABEL = 'Note for the kitchen';
export const ITEM_SHEET_NOTE_PLACEHOLDER = 'e.g. medium rare, no onions';

/**
 * Under the note field. THE POINT OF THE WHOLE CHANGE, said once where it is actionable: a note
 * belongs to what you are adding now, so two steaks cooked differently are two taps.
 */
export const ITEM_SHEET_NOTE_HINT =
  'This note goes to the kitchen for everything you add here. For a different note, add it separately.';

/** Above the stepper. */
export const ITEM_SHEET_QUANTITY_LABEL = 'How many?';

/**
 * At the quantity ceiling. Says the limit and what to do about it, rather than a dead button — a
 * waiter ringing up a party of thirty needs to know the round is the thing that splits, not that
 * the terminal is broken.
 */
export const ITEM_SHEET_QUANTITY_CAPPED =
  'Up to {max} at a time. Add another round for more.';

/** The confirm. Names what it does to the basket rather than "OK". */
export const ITEM_SHEET_ADD = 'Add to round';

/** Leaves without adding. Says the consequence, so it is not confused with removing an item. */
export const ITEM_SHEET_CANCEL = 'Cancel — nothing added';

/**
 * The sheet reopened on an existing basket line, to fix a note or a quantity. The confirm changes
 * wording because "Add to round" on a line that is already in the round would read as a second
 * helping.
 */
export const ITEM_SHEET_SAVE = 'Save changes';
