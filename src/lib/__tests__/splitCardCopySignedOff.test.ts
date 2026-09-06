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

  it('ten strings, and no eleventh added without a signature', () => {
    const exported = Object.keys(Copy).filter(
      k => typeof (Copy as Record<string, unknown>)[k] === 'string',
    );
    expect(exported).toHaveLength(10);
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
