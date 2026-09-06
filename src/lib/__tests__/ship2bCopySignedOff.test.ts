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

describe('the two round strings are retired, not merely unused', () => {
  /**
   * ROUND_SPLIT_ONE_OFF and ROUND_NOTE_APPLIES_TO_ALL were signed 2026-09-04 and shipped in 127.
   * The item sheet (2026-09-06) replaced the arrangement they belonged to: the note is asked for
   * when the item is added, and addLine merges only into a line with the same note, so there is
   * nothing to split and no multi-unit line for a note to be silently applied across.
   *
   * They stay in the file because deleting a signed string makes the signature unauditable. This
   * asserts they render NOWHERE, so wiring one back in is a decision somebody has to make on
   * purpose rather than a revert nobody notices.
   */
  it('nothing in the app renders either of them', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {readFileSync, readdirSync, statSync} = require('fs') as {
      readFileSync: (p: string, e: string) => string;
      readdirSync: (p: string) => string[];
      statSync: (p: string) => {isDirectory: () => boolean};
    };
    const resolve = (require as unknown as {resolve: (m: string) => string}).resolve;
    // Normalised to forward slashes so the same cut works on Windows and on CI.
    const resolved = resolve('../../constants/serviceCopy').split('\\').join('/');
    const SRC = resolved.slice(0, resolved.lastIndexOf('/constants/'));

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === '__tests__') continue;
        const full = dir + '/' + name;
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && !full.endsWith('/constants/serviceCopy.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/ROUND_SPLIT_ONE_OFF|ROUND_NOTE_APPLIES_TO_ALL/.test(text)) {
            offenders.push(full.slice(SRC.length + 1));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
