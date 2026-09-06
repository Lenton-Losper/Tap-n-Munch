/**
 * EVERY STRING FOR A PART-ORDER CARD PAYMENT.
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
 * THE SITUATION THESE ARE READ IN
 * ================================================================================================
 *
 * Three people at a table, each paying by card for their own items, with the tab still open and a
 * fourth still ordering. The waiter is standing there. Every one of these is read with a customer
 * waiting and a card machine in hand, which is why the refusals say what to do rather than only
 * what went wrong.
 *
 * SIGNED BY THE OWNER 2026-09-08, all ten as written, no changes.
 * Pinned in src/lib/__tests__/splitCardCopySignedOff.test.ts.
 *
 * On the held state, at signing: "Leading with 'may have been charged' is what makes the
 * prohibitions land, and ending with 'get a manager' is the honest end of a sentence about
 * something that never auto-resolves."
 */

/**
 * ================================================================================================
 * THE ONE DOING THE MOST WORK
 * ================================================================================================
 *
 * An ambiguous card outcome. E04111 from this gateway means NO RECORD, never NOT PAID, so the
 * customer may well have been charged — and the items stay held rather than released.
 *
 * A WAITER SEEING ITEMS THEY CANNOT TAKE PAYMENT FOR WILL REACH FOR CASH. That is the failure this
 * string exists to prevent, and it is why the prohibitions are explicit rather than implied by
 * "pending". Both wrong moves are named: taking cash charges the table twice if the card lands, and
 * re-running the card charges twice immediately.
 *
 * IT LEADS WITH THE CONSEQUENCE, per house style on money. "The customer may have been charged" is
 * the fact that makes the two prohibitions obviously correct; leading with "this did not confirm"
 * would read as a failure and invite exactly the recovery it is trying to stop.
 *
 * IT ENDS WITH AN EXIT. Without one, a waiter waits indefinitely or overrides. Nothing auto-
 * resolves an uncertain payment — a webhook or a human, and nothing else — so the human is named.
 */
export const SPLIT_CARD_PENDING_TITLE = 'Card not confirmed yet';

export const SPLIT_CARD_PENDING_BODY =
  'The customer may have been charged. These items stay held until the bank confirms — do not take cash for them, and do not run the card again. If they are still held after a few minutes, get a manager.';

/**
 * The per-item label on a held row. Short enough for a line on a P5, and it must not read as an
 * error: the row is not broken, it is waiting.
 */
export const SPLIT_CARD_PENDING_ROW = 'Card pending';

/**
 * Tapping a held item, or trying to settle a selection that includes one. Server code
 * ITEMS_HELD_BY_CARD.
 *
 * Says which way out exists. "Wait" alone would leave a waiter with a customer and no next step,
 * and the next step they invent is cash.
 */
export const SPLIT_CARD_ITEMS_HELD =
  'Someone is already paying for these by card. Wait for that to finish before taking payment for them — the rest of the bill can still be settled.';

/**
 * The gateway said no. The items are released and free for anyone to pay, which is the one case
 * where reaching for cash is exactly right — so it says so.
 */
export const SPLIT_CARD_DECLINED =
  'The card was declined and nothing was charged. Those items are free to pay for again — try another card, or take cash.';

/** It worked. A success must not read like a warning. */
export const SPLIT_CARD_PAID = 'Paid by card.';

/**
 * Server code SETTLEMENT_FAILED_AFTER_CHARGE. THE MONEY MOVED AND THE LEDGER DID NOT.
 *
 * The most dangerous state in the feature and the rarest. The customer HAS paid; the terminal
 * cannot show it. "Do not charge again" is the whole message and it comes first, because every
 * instinct in the moment is to retry.
 */
export const SPLIT_CARD_CHARGED_NOT_RECORDED =
  'The card went through but the bill could not be updated. Do not charge again. Get a manager and note the table before the customer leaves.';

/**
 * Server code NO_FINATIC_CREDENTIALS. The venue has no card setup at all, so this is not something
 * the waiter can fix at the table — it says who can.
 */
export const SPLIT_CARD_NOT_SET_UP =
  'Card payments are not set up for this venue. Take cash, and ask the owner to finish card setup.';

/**
 * Server code ALLOCATION_NOT_PAYABLE. Somebody else settled or removed these while this waiter was
 * looking at them, which on a shared tab is ordinary rather than an error.
 */
export const SPLIT_CARD_ITEMS_GONE =
  'Those items have already been paid for or taken off the bill. Refresh the table and check what is left.';

/** While the reader is up. Matches the whole-order flow's tone rather than inventing a second one. */
export const SPLIT_CARD_IN_PROGRESS = 'Follow the card machine…';
