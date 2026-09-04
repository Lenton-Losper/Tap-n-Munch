/**
 * Ship 2b's twelve strings plus the two Split strings, SIGNED 2026-09-04, pinned character for
 * character.
 *
 * These ship inside an APK, so drift is not fixable by a deploy. And this dialog in particular is
 * read at the worst moment of a shift — a customer has walked out and the room is watching — so a
 * tidier "improving" the tone is exactly the change nobody would notice until it is on a device.
 */
import * as Close from '../../constants/closeTableCopy';
import * as Copy from '../../constants/serviceCopy';

const SIGNED_CLOSE = {
  CLOSE_REFUSED_TITLE: 'Not ready to close',
  CLOSE_REFUSED_BODY: 'Sort these first:',
  CLOSE_REFUSED_DISMISS: 'Not yet',
  CLOSE_REFUSED_MORE: 'and {count} more',
  WALKOUT_OFFER_TITLE: 'Customer left without paying?',
  WALKOUT_OFFER_BODY: 'A manager can close this table. {amount} will be recorded as unpaid.',
  WALKOUT_PICK_MANAGER: 'Who is authorising this?',
  WALKOUT_PIN_PROMPT: "{name}'s PIN",
  WALKOUT_REASON_PROMPT: 'Why is this being closed unpaid?',
  WALKOUT_CONFIRM: 'Close and record',
  WALKOUT_REFUSED_PIN: 'That PIN cannot authorise this. A manager or owner must do it.',
  WALKOUT_NO_MANAGERS:
    'Nobody at this venue can authorise a walkout. Ask the owner to grant it on the staff page.',
} as const;

const SIGNED_ROUND = {
  ROUND_NOTE_APPLIES_TO_ALL: 'This note goes to the kitchen for all {count}.',
  ROUND_SPLIT_ONE_OFF: 'Split one off',
} as const;

describe('close-table dialog copy — signed 2026-09-04', () => {
  it.each(Object.entries(SIGNED_CLOSE))('%s is exactly as signed', (name, text) => {
    expect((Close as unknown as Record<string, string>)[name]).toBe(text);
  });

  it('all twelve are present', () => {
    expect(Object.keys(SIGNED_CLOSE)).toHaveLength(12);
  });

  it('the dismiss button never says "Close" — it dismisses, it does not close', () => {
    // The original said exactly that, on the dialog for closing a table.
    expect(SIGNED_CLOSE.CLOSE_REFUSED_DISMISS).not.toMatch(/^close$/i);
  });

  it('names the amount before the PIN is asked for', () => {
    // A manager authorising a write-off should see the number while deciding, not after.
    expect(SIGNED_CLOSE.WALKOUT_OFFER_BODY).toContain('{amount}');
  });

  it('every placeholder survives — a dropped one still reads like a sentence', () => {
    expect(SIGNED_CLOSE.CLOSE_REFUSED_MORE).toContain('{count}');
    expect(SIGNED_CLOSE.WALKOUT_PIN_PROMPT).toContain('{name}');
  });

  it('the no-managers string says how to FIX it, not only that it is broken', () => {
    // The person reading it is the one who has to fix it.
    expect(SIGNED_CLOSE.WALKOUT_NO_MANAGERS).toMatch(/staff page/i);
  });

  it('uses no smart dashes', () => {
    for (const s of Object.values(SIGNED_CLOSE)) {
      expect(s).not.toMatch(/[–—]/);
    }
  });

  it('leaves the twelve refusal strings untouched — presentation was the problem', () => {
    expect(Close.CLOSE_TABLE_REFUSAL_COPY.UNPAID_BALANCE).toBe(
      'There is still money owed on this table. Take payment first.',
    );
    expect(Close.CLOSE_TABLE_REFUSAL_COPY.OUTSTANDING_LINE).toBe(
      'Something on this table is still being made. Wait for it, or void it.',
    );
  });
});

describe('round-screen split copy — signed 2026-09-04', () => {
  it.each(Object.entries(SIGNED_ROUND))('%s is exactly as signed', (name, text) => {
    expect((Copy as Record<string, string>)[name]).toBe(text);
  });

  it('the warning states the CONSEQUENCE, not the rule', () => {
    // What the kitchen will receive is the thing the waiter is about to get wrong.
    expect(SIGNED_ROUND.ROUND_NOTE_APPLIES_TO_ALL).toMatch(/kitchen/i);
    expect(SIGNED_ROUND.ROUND_NOTE_APPLIES_TO_ALL).toContain('{count}');
  });

  it('the button says what it does to the basket, not the operation name', () => {
    expect(SIGNED_ROUND.ROUND_SPLIT_ONE_OFF).not.toBe('Split');
  });
});
