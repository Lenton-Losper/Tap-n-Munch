/**
 * EVERY STRING ON THE VOID APPROVAL BLOCK.
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
 * WHY THESE EXIST AT ALL
 * ================================================================================================
 *
 * Taking food off a bill used to need nothing: any waiter, no PIN, no reason, and the record said
 * a terminal did it and named no human. It now needs a manager or owner PIN and a reason, and
 * these are the words the person at the table reads while that happens.
 *
 * SIGNED: pending.
 */

/**
 * The heading on the approval block. Says what is being asked for and why, in that order, because
 * the waiter reading it is standing in front of a customer waiting for an answer.
 */
export const VOID_NEEDS_APPROVAL_TITLE = 'A manager has to approve this';

/**
 * The body. It names the consequence — the money leaves the bill — rather than describing the
 * control, and it says the record keeps a name, which is the honest reason a PIN is being asked
 * for rather than a hoop.
 */
export const VOID_NEEDS_APPROVAL_BODY =
  'Taking items off a bill takes the money off it too. A manager or owner approves it with their PIN, and their name stays on the record.';

/** Above the row of manager chips. A question, because the waiter is about to point at someone. */
export const VOID_PICK_MANAGER = 'Who is approving this?';

/**
 * The PIN field. Carries {name} so the waiter hands the terminal to the right person — a bare
 * "Enter PIN" gets typed by whoever is holding it.
 */
export const VOID_PIN_PROMPT = "{name}'s PIN";

/**
 * The reason field. Asks the question a person would ask out loud. It is stored and read later by
 * somebody reconciling the bill, so it wants a sentence, not a code.
 */
export const VOID_REASON_PROMPT = 'Why is it coming off?';

/**
 * Nobody at this venue can approve one. Says what to do rather than leaving the waiter pressing a
 * dead button — and does not promise the item can come off, because it cannot until someone can.
 */
export const VOID_NO_MANAGERS =
  'Nobody here can approve taking items off a bill. A manager or owner has to be added in Settings first. The item stays on the bill until then.';

/** The button. Short, and says what it does rather than "Confirm". */
export const VOID_CONFIRM = 'Approve and take it off';

/**
 * The PIN was wrong, OR it belongs to somebody without the permission. Those are different facts
 * and both mean the same thing to the waiter: this person cannot approve it here. Saying which
 * would tell whoever is holding the terminal something about someone else's PIN.
 */
export const VOID_REFUSED_PIN =
  'That PIN was not accepted, so nothing came off the bill. Check who is approving it and try again.';

/**
 * Server code VOID_NEEDS_REASON (400). The screen asks for a reason before it will send, so a
 * waiter should never see this — it means the two sides disagree, and it says the safe thing:
 * nothing changed.
 */
export const VOID_NEEDS_REASON =
  'A reason is needed before this can come off the bill. Nothing has changed yet.';

/** Server code VOID_REASON_TOO_LONG (400). Says what to do, and the limit is not a secret. */
export const VOID_REASON_TOO_LONG =
  'That reason is too long. Shorten it to a sentence and try again — nothing has changed yet.';

/**
 * Server code VOID_NEEDS_AUTHORIZATION (403). Reached when a build that does not ask for a PIN
 * talks to a server that requires one. It must NOT read as a fault the waiter caused.
 */
export const VOID_NEEDS_AUTHORIZATION =
  'This terminal is out of date and cannot take items off a bill. Nothing has changed. Update the app, or ask a manager to remove it from the dashboard.';

/**
 * A REDUCTION THAT IS NOT ZERO IS STILL A VOID.
 *
 * AMEND_EFFECT_CHANGE ("the kitchen sees the old line disappear and a new one arrive") is true of
 * every quantity change and says nothing about money. Going 3 to 1 writes two dishes off the bill,
 * and the waiter should read that before they ask a manager to approve it.
 */
export const VOID_EFFECT_REDUCE =
  'This takes {count} off the order and off the bill. The rest stays.';

/** One item, so the sentence above does not read "takes 1 off". */
export const VOID_EFFECT_REDUCE_ONE = 'This takes one off the order and off the bill. The rest stays.';
