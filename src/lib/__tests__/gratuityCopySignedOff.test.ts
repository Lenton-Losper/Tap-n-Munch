/**
 * THE SIGNED GRATUITY COPY. SIGNED BY THE OWNER 2026-09-05.
 *
 * Nine strings, every one shown to a waiter at a table with a customer waiting. Pinned as written
 * so a tidy-up, a refactor, or someone "improving" a sentence fails here rather than silently
 * changing what is read mid-service.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review: get the new
 * wording signed, change the constants in the same commit as this file, and say who signed it and
 * when.
 *
 * ============================================================================================
 * TWO OWNER EDITS AT SIGNING, BOTH RECORDED HERE BECAUSE BOTH HAVE A REASON
 * ============================================================================================
 *
 * 1. GRATUITY_NO_STAFF said a waiter could "settle without one" without naming what they lose —
 *    and the customer may already have agreed to a tip. It now says "settle without a gratuity".
 *
 * 2. GRATUITY_ADD lost its leading plus. Two buttons reading "+ Add something" side by side is
 *    how a waiter taps the wrong one mid-service; the neighbour is "Add Round".
 */
import {
  GRATUITY_ADD,
  GRATUITY_AMOUNT_LABEL,
  GRATUITY_ASSIGNED_HINT,
  GRATUITY_CHANGE,
  GRATUITY_CHOOSE,
  GRATUITY_NEEDS_STAFF,
  GRATUITY_NO_STAFF,
  GRATUITY_PICKER_HEADING,
  GRATUITY_REMOVE,
} from '../../constants/gratuityCopy';
import {TABLE_ADD_ROUND_BUTTON} from '../../constants/serviceCopy';

const SIGNED_ON = '2026-09-05';

describe(`the signed gratuity copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(GRATUITY_ADD).toBe('Add gratuity');
    expect(GRATUITY_AMOUNT_LABEL).toBe('Gratuity');
    expect(GRATUITY_REMOVE).toBe('Remove');
    expect(GRATUITY_PICKER_HEADING).toBe('Who is taking this gratuity?');
    expect(GRATUITY_ASSIGNED_HINT).toBe('Assigned to this table');
    expect(GRATUITY_CHANGE).toBe('Change');
    expect(GRATUITY_CHOOSE).toBe('Choose a staff member');
    expect(GRATUITY_NEEDS_STAFF).toBe('Choose who is taking this gratuity.');
    expect(GRATUITY_NO_STAFF).toBe(
      'No staff members are set up for this venue. Add staff in Settings, or settle without a gratuity.',
    );
  });

  it('the entry button carries no leading plus, and cannot collide with Add Round', () => {
    expect(GRATUITY_ADD.startsWith('+')).toBe(false);
    // The neighbour it must not be confused with. If that one ever grows a plus, this pairing
    // needs looking at again — which is why it is asserted here rather than described.
    expect(TABLE_ADD_ROUND_BUTTON.startsWith('+')).toBe(false);
    expect(GRATUITY_ADD).not.toBe(TABLE_ADD_ROUND_BUTTON);
  });

  it('the empty-staff message names what is lost, not just that staff are missing', () => {
    // "Settle without one" read as a harmless option; the thing given up is the customer's tip.
    expect(GRATUITY_NO_STAFF).toContain('without a gratuity');
    expect(GRATUITY_NO_STAFF).not.toContain('without one');
  });

  it('no string claims the picker is verified, authorised or approved', () => {
    /**
     * LOAD-BEARING, NOT STYLISTIC. The picker is an UNVERIFIED claim — anyone holding the terminal
     * can pick anyone. Those words would be false here, and would invite the next person to reuse
     * the pattern for a refund or a walkout close, which must keep their PIN.
     */
    const all = [
      GRATUITY_ADD,
      GRATUITY_AMOUNT_LABEL,
      GRATUITY_ASSIGNED_HINT,
      GRATUITY_CHANGE,
      GRATUITY_CHOOSE,
      GRATUITY_NEEDS_STAFF,
      GRATUITY_NO_STAFF,
      GRATUITY_PICKER_HEADING,
      GRATUITY_REMOVE,
    ];
    for (const s of all) {
      const lower = s.toLowerCase();
      expect(lower).not.toContain('verified');
      expect(lower).not.toContain('authoris');
      expect(lower).not.toContain('authoriz');
      expect(lower).not.toContain('approved');
      expect(lower).not.toContain('pin');
    }
  });

  it('says "gratuity", not "tip", on every staff-facing string that names it', () => {
    // Matches the receipt line, which prints "Gratuity".
    const namesIt = [
      GRATUITY_ADD,
      GRATUITY_AMOUNT_LABEL,
      GRATUITY_NEEDS_STAFF,
      GRATUITY_NO_STAFF,
      GRATUITY_PICKER_HEADING,
    ];
    for (const s of namesIt) {
      expect(s.toLowerCase()).toContain('gratuity');
      expect(s.toLowerCase()).not.toMatch(/\btip\b/);
    }
  });
});
