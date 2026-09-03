/**
 * The seven cooked-progress / half-voided strings, SIGNED 2026-09-03, pinned character for
 * character.
 *
 * Same discipline as the web repo's recipe-quantity-copy-signed-off suite, and for the same
 * reason: signed copy that only exists as a constant gets "tidied" — shortened, re-cased, or given
 * a smart dash by an editor — and nobody notices until a waiter reads it. These strings ship inside
 * an APK, so a drift is not fixable by a deploy; it needs a rebuild and a TMS upload.
 */
import * as Copy from '../../constants/serviceCopy';

const SIGNED = {
  TABLE_LINE_COOKED_CHIP: 'Nearly ready',
  TABLE_COOKED_PROGRESS_KITCHEN: 'Kitchen {cooked} of {total} plated',
  TABLE_COOKED_PROGRESS_BAR: 'Bar {cooked} of {total} poured',
  TABLE_LINE_KITCHEN_CANCELLED_BAR_READY: 'Bar ready · Kitchen cancelled',
  TABLE_LINE_BAR_CANCELLED_KITCHEN_READY: 'Kitchen ready · Bar cancelled',
  TABLE_LINE_KITCHEN_CANCELLED: 'Kitchen cancelled · Bar still coming',
  TABLE_LINE_BAR_CANCELLED: 'Bar cancelled · Kitchen still coming',
} as const;

describe('cooked-progress copy — signed 2026-09-03', () => {
  it.each(Object.entries(SIGNED))('%s is exactly as signed', (name, text) => {
    expect((Copy as Record<string, string>)[name]).toBe(text);
  });

  it('the two progress strings keep BOTH placeholders', () => {
    // A missing {total} renders "Kitchen 2 of {total} plated" on a live screen; a missing {cooked}
    // is worse, because it still reads like a sentence.
    for (const s of [SIGNED.TABLE_COOKED_PROGRESS_KITCHEN, SIGNED.TABLE_COOKED_PROGRESS_BAR]) {
      expect(s).toContain('{cooked}');
      expect(s).toContain('{total}');
    }
  });

  it('says CANCELLED, never voided, in the partial strings', () => {
    // 'Voided' is the whole-line chip. The partial case must not read as a variant of it.
    for (const s of [
      SIGNED.TABLE_LINE_KITCHEN_CANCELLED_BAR_READY,
      SIGNED.TABLE_LINE_BAR_CANCELLED_KITCHEN_READY,
      SIGNED.TABLE_LINE_KITCHEN_CANCELLED,
      SIGNED.TABLE_LINE_BAR_CANCELLED,
    ]) {
      expect(s.toLowerCase()).toContain('cancelled');
      expect(s.toLowerCase()).not.toContain('void');
    }
  });

  it('the cooked chip does not claim readiness', () => {
    // It ranks below Ready and must not read as "come and collect this".
    expect(SIGNED.TABLE_LINE_COOKED_CHIP).not.toBe(Copy.TABLE_LINE_READY_CHIP);
  });

  it('uses the existing middle dot separator, not a hyphen or an em dash', () => {
    for (const s of Object.values(SIGNED)) {
      expect(s).not.toMatch(/[–—]/);
    }
    expect(SIGNED.TABLE_LINE_KITCHEN_CANCELLED_BAR_READY).toContain(' · ');
  });

  it('carries no placeholder marker', () => {
    for (const s of Object.values(SIGNED)) {
      expect(s).not.toMatch(/PENDING|PLACEHOLDER|TODO|TBD/i);
    }
  });
});
