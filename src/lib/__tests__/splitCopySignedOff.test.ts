/**
 * The thirteen split-payment strings — twelve signed 2026-09-03, the entry button 2026-09-04.
 *
 * Same discipline as cookedCopySignedOff, and for the same reason: these ship inside an APK, so a
 * drift is not fixable by a deploy -- it needs a rebuild and a TMS upload. A tidier shortening
 * "A card payment is going through for part of this bill" to "Card payment in progress" would pass
 * every other test in this repo.
 */
import * as Copy from '../../constants/serviceCopy';

const SIGNED = {
  SPLIT_ASSIGN_TITLE: 'Who is paying for this?',
  SPLIT_ADD_PERSON: 'Add person',
  SPLIT_PERSON_PLACEHOLDER: 'Name',
  SPLIT_SHARE_WHOLE: 'All of it',
  SPLIT_SHARE_HALF: 'Half',
  SPLIT_UNASSIGNED: '{amount} not yet assigned',
  SPLIT_COLLECT_TITLE: 'Collect from {name}',
  SPLIT_COLLECT_TOTAL: '{name} owes {amount}',
  SPLIT_REMAINDER_OPEN: '{amount} still owing on this table',
  SPLIT_CARD_IN_FLIGHT:
    'A card payment is going through for part of this bill. Wait for it to finish, or cancel it on the terminal, then take cash.',
  SPLIT_NOTHING_SETTLED: 'None of these could be paid. They may already be settled.',
  SPLIT_LINE_VOIDED: 'This item was cancelled, so it cannot be paid for.',
  SPLIT_ENTRY_BUTTON: 'Split bill',
} as const;

describe('split-payment copy — signed 2026-09-03', () => {
  it.each(Object.entries(SIGNED))('%s is exactly as signed', (name, text) => {
    expect((Copy as Record<string, string>)[name]).toBe(text);
  });

  it('all thirteen are present', () => {
    expect(Object.keys(SIGNED)).toHaveLength(13);
    for (const name of Object.keys(SIGNED)) {
      expect(typeof (Copy as Record<string, string>)[name]).toBe('string');
    }
  });

  it('every placeholder survives — a dropped one still reads like a sentence', () => {
    // "{name} owes " renders as a plausible line on a live screen, which is how it survives review.
    expect(SIGNED.SPLIT_UNASSIGNED).toContain('{amount}');
    expect(SIGNED.SPLIT_COLLECT_TITLE).toContain('{name}');
    expect(SIGNED.SPLIT_COLLECT_TOTAL).toContain('{name}');
    expect(SIGNED.SPLIT_COLLECT_TOTAL).toContain('{amount}');
    expect(SIGNED.SPLIT_REMAINDER_OPEN).toContain('{amount}');
  });

  it('the card-in-flight refusal tells staff what to DO, not just that it failed', () => {
    // A refusal a waiter cannot act on becomes "the terminal is broken" within one shift.
    expect(SIGNED.SPLIT_CARD_IN_FLIGHT).toMatch(/wait/i);
    expect(SIGNED.SPLIT_CARD_IN_FLIGHT).toMatch(/cancel/i);
  });

  it('offers HALF and no other fraction — the owner ruled out N-way', () => {
    // Three people sharing a pizza is a rounding argument at the table.
    const fractions = Object.values(SIGNED).filter((s) =>
      /\b(third|quarter|fifth|split evenly|N-way)\b/i.test(s),
    );
    expect(fractions).toEqual([]);
    expect(SIGNED.SPLIT_SHARE_HALF).toBe('Half');
  });

  it('names no internal concept — no allocation, settle, ledger or void', () => {
    // These are read aloud at a table. "Allocate line" is not a sentence anyone says.
    for (const s of Object.values(SIGNED)) {
      expect(s.toLowerCase()).not.toMatch(/allocat|ledger|settle_|order_line/);
    }
  });

  it('uses no smart dashes — a punctuation pass is a silent reword', () => {
    for (const s of Object.values(SIGNED)) {
      expect(s).not.toMatch(/[–—]/);
    }
  });

  it('carries no placeholder marker', () => {
    for (const s of Object.values(SIGNED)) {
      expect(s).not.toMatch(/PENDING|PLACEHOLDER|TODO|TBD/i);
    }
  });
});
