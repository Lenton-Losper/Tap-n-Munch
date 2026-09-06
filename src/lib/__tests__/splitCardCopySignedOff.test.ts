/**
 * THE SIGNED SPLIT-CARD COPY. SIGNED BY THE OWNER 2026-09-08.
 *
 * Ten strings, read by a waiter with a customer waiting and a card machine in hand. Pinned as
 * written so a tidy-up, a refactor, or someone "improving" a sentence fails here rather than
 * silently changing what is read at a table.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review.
 *
 * ============================================================================================
 * THE HELD STATE IS PINNED BY PROPERTY, NOT ONLY BY STRING
 * ============================================================================================
 *
 * Owner, commissioning it: "A waiter seeing items they can't take payment for, with a customer
 * waiting, will reach for cash unless the wording stops them. That's the string doing the most work
 * in the whole feature."
 *
 * So the equality assertion is not the whole of it. Four properties are asserted separately,
 * because each is a way the string could be shortened into uselessness while still looking fine:
 * it must lead with the possible charge, forbid cash, forbid re-running the card, and name a way
 * out. A future edit that drops any one of them fails on the property, which says WHY, rather than
 * only on the equality, which says the text moved.
 */
import * as Copy from '../../constants/splitCardCopy';

const SIGNED_ON = '2026-09-08';

describe(`the signed split-card copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(Copy.SPLIT_CARD_PENDING_TITLE).toBe('Card not confirmed yet');
    expect(Copy.SPLIT_CARD_PENDING_BODY).toBe(
      'The customer may have been charged. These items stay held until the bank confirms — do not take cash for them, and do not run the card again. If they are still held after a few minutes, get a manager.',
    );
    expect(Copy.SPLIT_CARD_PENDING_ROW).toBe('Card pending');
    expect(Copy.SPLIT_CARD_ITEMS_HELD).toBe(
      'Someone is already paying for these by card. Wait for that to finish before taking payment for them — the rest of the bill can still be settled.',
    );
    expect(Copy.SPLIT_CARD_DECLINED).toBe(
      'The card was declined and nothing was charged. Those items are free to pay for again — try another card, or take cash.',
    );
    expect(Copy.SPLIT_CARD_PAID).toBe('Paid by card.');
    expect(Copy.SPLIT_CARD_CHARGED_NOT_RECORDED).toBe(
      'The card went through but the bill could not be updated. Do not charge again. Get a manager and note the table before the customer leaves.',
    );
    expect(Copy.SPLIT_CARD_NOT_SET_UP).toBe(
      'Card payments are not set up for this venue. Take cash, and ask the owner to finish card setup.',
    );
    expect(Copy.SPLIT_CARD_ITEMS_GONE).toBe(
      'Those items have already been paid for or taken off the bill. Refresh the table and check what is left.',
    );
    expect(Copy.SPLIT_CARD_IN_PROGRESS).toBe('Follow the card machine…');
  });

  it('seventeen strings, and no eighteenth added without a signature', () => {
    const exported = Object.keys(Copy).filter(
      k => typeof (Copy as Record<string, unknown>)[k] === 'string',
    );
    expect(exported).toHaveLength(17);
  });
});

const SIGNED_ON_REFUSALS = '2026-09-09';

describe(`the seven refusal strings (signed ${SIGNED_ON_REFUSALS})`, () => {
  it('read exactly as signed', () => {
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).toBe(
      'Do not take cash for these items. Someone may be paying for them by card right now and this terminal cannot check — taking cash could charge the customer twice. Nothing was charged just now: try again in a moment, or settle the rest of the bill.',
    );
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toBe(
      'The card may have been charged and this terminal could not record it. Do not charge again, and do not take cash for these items. Get a manager now, and note the table and the amount before the customer leaves.',
    );
    expect(Copy.SPLIT_CARD_TERMINAL_NOT_ALLOWED).toBe(
      'This terminal is not allowed to take payments. Nothing was charged. Use another terminal, or get a manager to check this one.',
    );
    expect(Copy.SPLIT_CARD_BY_ITEM_NOT_ENABLED).toBe(
      'This venue is not set up for paying by item. Nothing was charged. Take payment for the whole order instead, or ask the owner to turn it on.',
    );
    expect(Copy.SPLIT_CARD_NOTHING_TO_CHARGE).toBe(
      'There is nothing to charge on this selection. Nothing was charged. Tick the items the customer is paying for and try again.',
    );
    expect(Copy.SPLIT_CARD_TABLE_OUT_OF_DATE).toBe(
      "This table's bill could not be read. Nothing was charged. Go back, open the table again, and pick the items fresh.",
    );
    expect(Copy.SPLIT_CARD_NOT_STARTED).toBe(
      'The payment could not be started, and nothing was charged. Try again. If it keeps failing, take cash and tell a manager.',
    );
  });
});

/**
 * ==================================================================================================
 * THE CASH CONTRAST -- PINNED SEPARATELY FROM THE EQUALITY ASSERTIONS
 * ==================================================================================================
 *
 * Owner, at signing 2026-09-09: "The cash contrast is right and it's the thing to protect:
 * forbidden in 1 and 2, offered in 7. If anyone ever softens 'Do not take cash for these items'
 * the whole set stops working, so pin that phrase specifically."
 *
 * The equality tests above already fail if the text moves. These exist because they fail with a
 * message that says WHY: a future edit that trims a sentence for length gets told it removed the
 * prohibition, not merely that a string changed.
 */
describe('the cash contrast, which is what makes the prohibitions mean anything', () => {
  const EXACT_PROHIBITION = 'Do not take cash for these items';
  /**
   * The same words, wherever they sit in a sentence. HOLD_UNKNOWN opens with them, so it carries
   * the capital; OUTCOME_NOT_RECORDED puts them after "Do not charge again, and", so it does not.
   * The wording is what is being protected, not the capitalisation.
   */
  const PROHIBITION_WORDS = /do not take cash for these items/i;

  it('the exact phrase survives, verbatim, in both strings that forbid cash', () => {
    // Verbatim word-for-word. "Please avoid taking cash" is a softening, and it would pass a
    // looser check while telling a waiter something they can talk themselves out of.
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).toContain(EXACT_PROHIBITION);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(PROHIBITION_WORDS);
  });

  it('the hold-unknown string LEADS with the prohibition', () => {
    /**
     * The one string in the set where the action outranks the consequence. The waiter's hand is
     * already moving toward the till; an explanation first means the prohibition arrives late.
     */
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN.startsWith(EXACT_PROHIBITION)).toBe(true);
  });

  it('it says WHY, in money terms a waiter acts on', () => {
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).toMatch(/charge the customer twice/i);
  });

  it('it does not echo the phrase forbidden in the held state', () => {
    /**
     * "Run the card again" is prohibited in SPLIT_CARD_PENDING_BODY. Retrying IS safe here -- the
     * hold check runs before any intent is minted -- but a waiter who half-remembers one string
     * must not hear an echo of the other, so this one says "try again" and never "the card again".
     */
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).not.toMatch(/card again/i);
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).toMatch(/try again/i);
  });

  it('it names a way to keep working', () => {
    // Believing the whole table is blocked is itself a reason waiters improvise.
    expect(Copy.SPLIT_CARD_HOLD_UNKNOWN).toMatch(/rest of the bill/i);
  });

  it('the record-side string forbids BOTH wrong moves and names an urgent exit', () => {
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(/do not charge again/i);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(PROHIBITION_WORDS);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(/get a manager/i);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(/before the customer leaves/i);
  });

  it('it claims nothing it cannot know', () => {
    /**
     * "May have been charged", never "was charged" -- that is SPLIT_CARD_CHARGED_NOT_RECORDED's
     * claim and it is a different, provable state. And it must not promise the items are held:
     * the server may never have heard the outcome, so there may be no intent holding anything.
     */
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).toMatch(/may have been charged/i);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).not.toMatch(/went through/i);
    expect(Copy.SPLIT_CARD_OUTCOME_NOT_RECORDED).not.toMatch(/stay held|held until/i);
  });

  it('AND cash is explicitly OFFERED where it is safe', () => {
    /**
     * Without this half the contrast collapses. A set in which every refusal says "do not take
     * cash" teaches a waiter that the sentence is boilerplate, and then the two that mean it stop
     * being read.
     */
    expect(Copy.SPLIT_CARD_NOT_STARTED).toMatch(/take cash/i);
    expect(Copy.SPLIT_CARD_NOT_STARTED).not.toMatch(/do not take cash/i);
    expect(Copy.SPLIT_CARD_DECLINED).toMatch(/take cash/i);
    expect(Copy.SPLIT_CARD_NOT_SET_UP).toMatch(/take cash/i);
  });

  it('exactly three strings forbid cash, and they are the three that must', () => {
    /**
     * A census rather than a spot check, and it earned its place immediately: it caught that this
     * list was written as two when it is three. SPLIT_CARD_PENDING_BODY -- the held state, signed
     * 2026-09-08 -- was the FIRST string to forbid cash, and the two added on 2026-09-09 join it.
     *
     * All three are the same situation seen from different angles: money may have moved and we
     * cannot prove it. If a fourth ever starts forbidding cash, either a new dangerous state exists
     * and this list is updated on purpose, or a prohibition has leaked somewhere it will be ignored
     * -- and a prohibition that appears where it is not needed is how the ones that matter stop
     * being read.
     */
    const forbidding = Object.entries(Copy)
      .filter(([, v]) => typeof v === 'string' && /do not take cash/i.test(v as string))
      .map(([k]) => k)
      .sort();
    expect(forbidding).toEqual([
      'SPLIT_CARD_HOLD_UNKNOWN',
      'SPLIT_CARD_OUTCOME_NOT_RECORDED',
      'SPLIT_CARD_PENDING_BODY',
    ]);
  });
});

describe('every prepare-side string says nothing was charged', () => {
  it('because a waiter who does not know that stalls a table', () => {
    /**
     * These are all reached before the reader is launched, so the reassurance is TRUE of every one
     * of them -- and it is what lets a waiter act instead of standing still with a customer.
     */
    for (const name of [
      'SPLIT_CARD_TERMINAL_NOT_ALLOWED',
      'SPLIT_CARD_BY_ITEM_NOT_ENABLED',
      'SPLIT_CARD_NOTHING_TO_CHARGE',
      'SPLIT_CARD_TABLE_OUT_OF_DATE',
      'SPLIT_CARD_NOT_STARTED',
    ] as const) {
      const text = Copy[name];
      expect({name, saysSo: /nothing was charged/i.test(text)}).toEqual({name, saysSo: true});
    }
  });
});

describe('the held state — the four properties it was signed for', () => {
  const body = Copy.SPLIT_CARD_PENDING_BODY;

  it('LEADS with the possible charge', () => {
    /**
     * House style on money is consequence first, and here it is load-bearing: "the customer may
     * have been charged" is what makes the two prohibitions obviously correct. Leading with "this
     * did not confirm" would read as a failure and invite the very recovery it is stopping.
     */
    expect(body.indexOf('may have been charged')).toBeGreaterThan(-1);
    expect(body.indexOf('may have been charged')).toBeLessThan(40);
  });

  it('forbids CASH explicitly', () => {
    // The move a waiter reaches for. Taking cash charges the table twice if the card lands.
    expect(body).toMatch(/do not take cash/i);
  });

  it('forbids RE-RUNNING THE CARD explicitly', () => {
    // A different mistake from cash, and immediate rather than conditional — so it is named
    // separately rather than folded into one prohibition.
    expect(body).toMatch(/do not run the card again/i);
  });

  it('names a way out', () => {
    /**
     * Nothing auto-resolves an uncertain payment — a webhook or a human, and nothing else. Without
     * an exit a waiter either waits indefinitely or overrides, and overriding is the failure.
     */
    expect(body).toMatch(/get a manager/i);
  });

  it('never says paid, failed or declined', () => {
    // Each would be a claim this state cannot make. "Held" is the only honest word.
    for (const forbidden of [/\bpaid\b/i, /\bfailed\b/i, /\bdeclined\b/i]) {
      expect({ forbidden: String(forbidden), present: forbidden.test(body) }).toEqual({
        forbidden: String(forbidden),
        present: false,
      });
    }
  });

  it('the row label is short, and is not an error', () => {
    expect(Copy.SPLIT_CARD_PENDING_ROW.length).toBeLessThanOrEqual(16);
    expect(Copy.SPLIT_CARD_PENDING_ROW).not.toMatch(/fail|error|problem/i);
  });
});

describe('the states that DO permit taking the money again say so', () => {
  it('a decline says nothing was charged, and offers cash', () => {
    /**
     * The contrast that makes the held state legible. If both read as "something went wrong", the
     * distinction that matters — may have been charged, versus definitely was not — is lost.
     */
    expect(Copy.SPLIT_CARD_DECLINED).toMatch(/nothing was charged/i);
    expect(Copy.SPLIT_CARD_DECLINED).toMatch(/take cash/i);
    expect(Copy.SPLIT_CARD_PENDING_BODY).not.toMatch(/nothing was charged/i);
  });

  it('the held-by-someone-else message says the rest of the bill still works', () => {
    // Without it a waiter reads the whole table as blocked and goes looking for a way round.
    expect(Copy.SPLIT_CARD_ITEMS_HELD).toMatch(/rest of the bill/i);
  });
});

describe('the charged-but-not-recorded state', () => {
  it('leads with do not charge again', () => {
    // The rarest and worst state. Every instinct in the moment is to retry.
    const text = Copy.SPLIT_CARD_CHARGED_NOT_RECORDED;
    expect(text).toMatch(/do not charge again/i);
    expect(text.indexOf('Do not charge again')).toBeLessThan(text.indexOf('manager'));
  });

  it('says to act before the customer leaves', () => {
    // The recovery needs a person who is still in the room.
    expect(Copy.SPLIT_CARD_CHARGED_NOT_RECORDED).toMatch(/before the customer leaves/i);
  });
});

describe('every refusal says what to do', () => {
  it('names an action, not only a problem', () => {
    /**
     * The rule this whole file was drafted against: the move a waiter invents when told only "no"
     * is cash, and on a held item that is the one thing they must not do.
     */
    for (const [name, text] of [
      ['SPLIT_CARD_PENDING_BODY', Copy.SPLIT_CARD_PENDING_BODY],
      ['SPLIT_CARD_ITEMS_HELD', Copy.SPLIT_CARD_ITEMS_HELD],
      ['SPLIT_CARD_DECLINED', Copy.SPLIT_CARD_DECLINED],
      ['SPLIT_CARD_CHARGED_NOT_RECORDED', Copy.SPLIT_CARD_CHARGED_NOT_RECORDED],
      ['SPLIT_CARD_NOT_SET_UP', Copy.SPLIT_CARD_NOT_SET_UP],
      ['SPLIT_CARD_ITEMS_GONE', Copy.SPLIT_CARD_ITEMS_GONE],
    ] as const) {
      const actionable =
        /get a manager|take cash|try another card|refresh|wait for|ask the owner|do not/i.test(text);
      expect({ name, actionable }).toEqual({ name, actionable: true });
    }
  });

  it('nothing is left as a placeholder', () => {
    for (const [name, text] of Object.entries(Copy)) {
      if (typeof text !== 'string') continue;
      expect({ name, placeholder: /PENDING COPY|TODO|TBD|XXX/i.test(text) }).toEqual({
        name,
        placeholder: false,
      });
    }
  });
});
