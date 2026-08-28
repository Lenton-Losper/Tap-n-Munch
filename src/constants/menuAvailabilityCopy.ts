/**
 * Wording for "mark a dish unavailable from the terminal".
 *
 * TEN OF THESE ARE SIGNED OFF AND ARE THE OWNER'S OWN WORDS, transcribed exactly. They are marked
 * SIGNED. Do not paraphrase, re-wrap, re-punctuate or "tighten" one of them; if a screen needs
 * different wording, that is a question for the owner, not an edit here.
 *
 * The rest are still PENDING COPY. They were not on the signed list and are reported in the
 * handover — every one of them exists because a screen cannot render without it.
 *
 * EVERY VALUE IS A PLAIN STRING LITERAL. Not a template literal, not a concatenation, not a value
 * built from a shared prefix. The copy gate is a SOURCE SCANNER: it reads this file as text and
 * cannot see through `${...}`, so a string assembled from parts is one the gate cannot check.
 * Substitutions are `{name}`-style tokens replaced at the call site — the convention already used
 * by constants/serviceCopy.ts (FLOOR_SUBTITLE, TABLE_HANDED_OVER_NOTICE).
 */

// ─── SIGNED: the control, the sheet, the toasts ──────────────────────────────────────────────

/**
 * SIGNED 1. The control in the item detail view, below the fold. It OPENS the sheet; it does not
 * itself hide anything.
 */
export const CONTROL_BUTTON_HIDE = 'Mark unavailable';

/** SIGNED 2. The sheet's title, above the dish name. */
export const SHEET_TITLE_HIDE = 'Mark this unavailable?';

/**
 * SIGNED 3. The sheet's body — the sentence that says what is about to happen.
 *
 * THE OWNER'S NOTE, KEPT BECAUSE IT IS THE REASON THE STRING EXISTS: it deliberately never says
 * "this table". A waiter reading a shorter version assumes the change is local to the table or the
 * device in their hand, and that misunderstanding is the entire risk this feature is designed
 * against. Do not shorten it into a label.
 *
 * OPEN QUESTION BACK TO THE OWNER: if a customer already holding this dish in a cart fails at
 * checkout, this string needs to warn about that and the owner will rewrite it. See the handover —
 * that trace lives in the web repo and was not checked from here.
 */
export const SHEET_BODY_HIDE = 'This removes the dish from the menu for every customer in the restaurant, on their phones and on every terminal. Nobody will be able to order it until it is put back.';

/** SIGNED 4. The accept button at the bottom of the sheet; pressing it spends the PIN. */
export const SHEET_ACCEPT_LABEL = 'Mark unavailable';

/**
 * SIGNED 5. The restore control. Used in TWO places, deliberately the same string: the button in
 * the detail view of an already-hidden dish, and the undo action inside the success toast.
 */
export const RESTORE_BUTTON = 'Put back on the menu';

/** SIGNED 6. Toast after a dish has been hidden. */
export const SUCCESS_HIDDEN = 'Off the menu. Nobody can order it now.';

/** SIGNED 7. Toast after a dish has been put back. */
export const SUCCESS_RESTORED = 'Back on the menu.';

// ─── SIGNED: refusals ────────────────────────────────────────────────────────────────────────
//
// THESE ARE FALLBACKS, NOT OVERRIDES, AND THAT IS A JUDGEMENT CALL WORTH KNOWING ABOUT.
//
// The build brief said: "The server returns a `message` for each refusal. Render the server's
// message; do not compose your own." The owner then signed wording for all three refusals. Both
// instructions came from the same person, so the screen honours both in the only order that cannot
// invent anything: the server's `message` wins whenever there is one, and these signed strings
// fill the hole when a refusal arrives with no message at all.
//
// The consequence, stated plainly so it is a decision and not a surprise: if staging's message
// text differs from what is written here, staging's text is what a waiter sees. To make the device
// authoritative instead, change refusalMessage() in screens/MenuItemDetailScreen.tsx to prefer the
// signed string over `message` — one line, and the strings below need no edit.

/** SIGNED 8. Refusal `item_not_found`. */
export const REFUSAL_ITEM_NOT_FOUND = 'This dish is no longer on the menu. Close this and open the menu again.';

/** SIGNED 9. Refusal `authorization_failed` — the PIN did not authorise the change. */
export const REFUSAL_AUTHORIZATION_FAILED = 'That PIN did not work. Try again, or ask a manager to do it.';

/**
 * SIGNED 10. Refusal `already_in_that_state`.
 *
 * THE OWNER'S NOTE, KEPT: it reads as information, not an error, because during service it usually
 * is — somebody else got to the same empty tray first. The screen shows it in the neutral style
 * for exactly that reason; do not restyle it as a failure.
 */
export const REFUSAL_ALREADY_IN_THAT_STATE = 'Somebody already took this off the menu.';

// ─── PENDING COPY: not on the signed list, reported in the handover ──────────────────────────

/**
 * PENDING. The restore direction's own sheet title.
 *
 * It cannot reuse SHEET_TITLE_HIDE: "Mark this unavailable?" over a button that PUTS THE DISH BACK
 * states the opposite of what the sheet does.
 */
export const SHEET_TITLE_RESTORE = 'PENDING COPY: title of the sheet that puts a hidden dish back on the menu';

/**
 * PENDING. The restore direction's own sheet body — the mirror of SHEET_BODY_HIDE. Same reason as
 * the title: signed string 3 says the dish is being REMOVED, which is wrong on this sheet.
 */
export const SHEET_BODY_RESTORE = 'PENDING COPY: sheet body for the restore direction — the dish becomes orderable again for every customer in the restaurant, on their phones and on every terminal';

/**
 * PENDING. Heading over the staff list inside the sheet, before a person has been picked. The PIN
 * is attributable to a person, so a person is named before it is entered.
 */
export const SHEET_STAFF_HEADING = 'PENDING COPY: heading over the list of staff who may change menu availability';

/** PENDING. The PIN prompt once a staff member is picked. `{name}` is that staff member. */
export const SHEET_PIN_PROMPT = 'PENDING COPY: prompt above the PIN entry — {name} is the staff member who was picked';

/**
 * PENDING. Shown when nobody at this venue may do this. An OPERATIONAL problem, not a code one: a
 * staff member needs both a PIN credential and the permission before they appear in the list.
 */
export const SHEET_STAFF_EMPTY = 'PENDING COPY: shown when no staff member is set up to change menu availability on this terminal';

/** PENDING. The detail view's label for a dish that is currently on the menu. */
export const STATUS_AVAILABLE = 'PENDING COPY: label for a dish that is currently on the menu';

/** PENDING. The detail view's label for a dish that is currently hidden from every menu. */
export const STATUS_HIDDEN = 'PENDING COPY: label for a dish that is currently hidden from every menu';

/** PENDING. The detail view could not load the item record at all, so nothing may be changed. */
export const DETAIL_LOAD_FAILED = 'PENDING COPY: shown when the item record could not be loaded, so nothing may be changed';

/**
 * PENDING. The record loaded, but the id is not in it — the dish was deleted, or moved out of the
 * category the device came from. Nothing may be changed, because there is no name to confirm.
 */
export const DETAIL_ITEM_MISSING = 'PENDING COPY: shown when the item is no longer in the menu record that was fetched';

/** PENDING. Retry control on either load failure above. */
export const RETRY_BUTTON = 'PENDING COPY: retry button on a failed load';

/**
 * PENDING. A refusal arrived with no `message` AND no signed string for its code — an unknown
 * refusal from a newer server. The hole, not a second copy of wording the server owns.
 */
export const REFUSAL_WITHOUT_MESSAGE = 'PENDING COPY: shown when the server refused the change but sent no message with it';

// ─── Behaviour, not copy ─────────────────────────────────────────────────────────────────────

/**
 * How long the undo action stays on the success toast, in milliseconds.
 *
 * THE SINGLE MOST IMPORTANT SAFETY PROPERTY OF THIS FEATURE, and worth more than any "are you
 * sure?" step: a mis-hidden dish must be a five-second recovery. Ten seconds is the briefed
 * window. Shortening it is a product decision, not a tidy-up.
 */
export const UNDO_WINDOW_MS = 10000;
