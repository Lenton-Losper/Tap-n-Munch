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
 * SIGNED BY THE OWNER 2026-09-08, the first ten as written, no changes.
 * SIGNED BY THE OWNER 2026-09-09, the seven refusal strings below, as written, no changes.
 * Pinned in src/lib/__tests__/splitCardCopySignedOff.test.ts.
 *
 * ================================================================================================
 * WHY SEVEN STRINGS AND NOT SEVENTEEN
 * ================================================================================================
 *
 * The two split-card routes have 22 refusal sites. Seventeen of them reached a waiter as RAW
 * SERVER ENGLISH until 2026-09-09 -- seven carried no error code at all, and ten carried a code
 * nothing mapped -- because the screen ended its lookup with `?? err.message`. That fallback was
 * written as a safety net and was in fact a hole: it guaranteed every refusal nobody had thought
 * about would be shown to a customer-facing screen in the words a server author typed for a log.
 *
 * The seventeen collapse into seven because SIGNED COPY IS PER SITUATION, NOT PER ERROR CODE. Two
 * codes that leave a waiter doing the same thing do not need two sentences. Two codes that leave
 * them doing OPPOSITE things must never share one.
 *
 * ================================================================================================
 * THE AXIS THAT DECIDES EVERY ONE OF THEM: HAS THE READER RUN YET
 * ================================================================================================
 *
 * PREPARE-SIDE, nothing has been charged. Cash is safe, and the string SAYS so -- a waiter who
 * does not know that stalls a table, or worse, assumes the opposite and does nothing.
 *
 * RECORD-SIDE, the reader has already run. Cash is NOT safe and neither is charging again.
 *
 * THE CASH CONTRAST IS THE LOAD-BEARING PART OF THIS SET. Cash is forbidden in
 * SPLIT_CARD_HOLD_UNKNOWN and SPLIT_CARD_OUTCOME_NOT_RECORDED and offered in
 * SPLIT_CARD_NOT_STARTED. Owner, at signing: "If anyone ever softens 'Do not take cash for these
 * items' the whole set stops working." That phrase is pinned by itself in the lock test.
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

/**
 * ================================================================================================
 * THE SEVEN REFUSAL STRINGS. SIGNED 2026-09-09.
 * ================================================================================================
 */

/**
 * Server code HOLD_CHECK_FAILED. THE MOST DANGEROUS REFUSAL ON THE PREPARE SIDE.
 *
 * The hold read failed, so we cannot tell whether another card is live on these items. The route
 * fails CLOSED -- not knowing is not permission to take the money again.
 *
 * It read "Could not confirm no card payment is in progress for these items": a system complaint,
 * naming no action, in front of a waiter with a customer waiting. The move they invent there is
 * cash, and cash is the one thing that turns this into a double charge.
 *
 * SO THE PROHIBITION IS THE FIRST FOUR WORDS, ahead of any explanation. This is the one string in
 * the set where the action outranks the consequence, because the waiter's hand is already moving.
 *
 * "TRY AGAIN", NOT "TRY THE CARD AGAIN". "Run the card again" is the forbidden phrase in the held
 * state, and a waiter who half-remembers one string must not hear an echo of it here. Retrying is
 * genuinely safe: the hold check runs BEFORE any intent is minted, so a failure here charged
 * nothing and reserved nothing.
 *
 * "Settle the rest of the bill" is there so the table is not read as wholly blocked -- believing
 * everything is stuck is itself a reason waiters reach for cash.
 */
export const SPLIT_CARD_HOLD_UNKNOWN =
  'Do not take cash for these items. Someone may be paying for them by card right now and this terminal cannot check — taking cash could charge the customer twice. Nothing was charged just now: try again in a moment, or settle the rest of the bill.';

/**
 * Server codes RECORD_BAD_TAB_ID, NO_REFERENCE, INTENT_LOOKUP_FAILED, NO_INTENT, WRONG_SCOPE,
 * RECORD_FAILED -- and any record-side failure with no code at all, including the request never
 * reaching the server.
 *
 * SIX CODES, ONE STRING, because the waiter does exactly the same thing in all of them and the
 * difference between them is diagnostic. The reader has run; what we lost is the bookkeeping.
 *
 * DISTINCT FROM SPLIT_CARD_CHARGED_NOT_RECORDED, which asserts the charge DID go through. Here we
 * do not know, and saying "the card went through" would be a claim this state cannot make.
 *
 * DISTINCT FROM THE HELD STATE, which can promise the items stay held until the bank confirms.
 * These cannot promise that -- there may be no intent row to hold anything -- so they do not.
 *
 * There is no retry affordance on this path, so a manager is the honest exit rather than a hedge.
 */
export const SPLIT_CARD_OUTCOME_NOT_RECORDED =
  'The card may have been charged and this terminal could not record it. Do not charge again, and do not take cash for these items. Get a manager now, and note the table and the amount before the customer leaves.';

/**
 * Server code MISSING_PERMISSION.
 *
 * Should be unreachable since 2026-09-09, when both routes moved off `payments:process` -- a
 * permission no terminal token can carry -- onto `orders:update`, which every terminal holds. It
 * still needs honest wording, because the alternative is the raw string that started all this:
 * a waiter at Digi Cofee reading "Missing permission" off a card machine.
 */
export const SPLIT_CARD_TERMINAL_NOT_ALLOWED =
  'This terminal is not allowed to take payments. Nothing was charged. Use another terminal, or get a manager to check this one.';

/**
 * Server code STATION_SCREENS_DISABLED. The venue does not have waiter-led service switched on.
 *
 * Names the workaround that actually works today rather than leaving the waiter with a refusal:
 * whole-order payment is unaffected by this flag.
 */
export const SPLIT_CARD_BY_ITEM_NOT_ENABLED =
  'This venue is not set up for paying by item. Nothing was charged. Take payment for the whole order instead, or ask the owner to turn it on.';

/** Server codes NO_ALLOCATIONS and NOT_CHARGEABLE. Nothing selected, or it adds up to nothing. */
export const SPLIT_CARD_NOTHING_TO_CHARGE =
  'There is nothing to charge on this selection. Nothing was charged. Tick the items the customer is paying for and try again.';

/**
 * Server codes BAD_TAB_ID, INVALID_ALLOCATION_ID, ITEMS_READ_FAILED. The screen is holding
 * something the server does not recognise, which on a shared tab usually means it moved underneath
 * this waiter.
 */
export const SPLIT_CARD_TABLE_OUT_OF_DATE =
  "This table's bill could not be read. Nothing was charged. Go back, open the table again, and pick the items fresh.";

/**
 * Server code PREPARE_FAILED -- and any prepare-side failure with no code, including the request
 * never reaching the server.
 *
 * CASH IS EXPLICITLY OFFERED HERE, and explicitly forbidden in SPLIT_CARD_HOLD_UNKNOWN and
 * SPLIT_CARD_OUTCOME_NOT_RECORDED. That contrast is what makes the prohibitions mean something: a
 * set where every refusal said "do not take cash" would teach a waiter to ignore the sentence.
 *
 * It is safe to say so. Every prepare-side failure happens before the reader is launched, so
 * "nothing was charged" is true of all of them.
 */
export const SPLIT_CARD_NOT_STARTED =
  'The payment could not be started, and nothing was charged. Try again. If it keeps failing, take cash and tell a manager.';
