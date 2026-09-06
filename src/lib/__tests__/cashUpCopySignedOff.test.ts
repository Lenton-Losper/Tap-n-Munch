/**
 * THE SIGNED CASH-UP COPY. SIGNED BY THE OWNER 2026-09-06.
 *
 * Twenty strings, every one shown to a manager closing up with the drawer open. Pinned as
 * written so a tidy-up, a refactor, or someone "improving" a sentence fails here rather than
 * silently changing what is read at the end of a shift.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review: get the new
 * wording signed, change the constants in the same commit as this file, and say who signed it and
 * when.
 *
 * ============================================================================================
 * THREE PROPERTIES THE OWNER CALLED OUT AT SIGNING, ASSERTED RATHER THAN DESCRIBED
 * ============================================================================================
 *
 * 1. EVERY REFUSAL SAYS NOTHING PRINTED. Owner: "a manager who thinks the first press half-worked
 *    will chase a phantom." CASH_UP_PRINTER_FAILED is the sharp case — the report was built and
 *    the PIN was spent, so the manager must be told the paper is the only thing that failed.
 * 2. THE PIN REASON NAMES THE NAME. A manager who thinks the PIN is a hoop shares the code; one
 *    who knows their name goes on the printout does not.
 * 3. NOTHING IS PROMISED THAT CANNOT HAPPEN. CASH_UP_NO_MANAGERS does not imply the printout is
 *    available in the meantime.
 */
import * as Copy from '../../constants/cashUpCopy';

const SIGNED_ON = '2026-09-06';

describe(`the signed cash-up copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(Copy.CASH_UP_TITLE).toBe('Cash-up');
    expect(Copy.CASH_UP_INTRO).toBe(
      'Prints the takings for a period: cash and card, what was sold, and any gratuities. It is not a tax invoice.',
    );
    expect(Copy.CASH_UP_PERIOD_LABEL).toBe('Which period?');
    expect(Copy.CASH_UP_PERIOD_TODAY).toBe('Today');
    expect(Copy.CASH_UP_PERIOD_YESTERDAY).toBe('Yesterday');
    expect(Copy.CASH_UP_PERIOD_THIS_WEEK).toBe('This week');
    expect(Copy.CASH_UP_PERIOD_HINT).toBe(
      'For any other dates, use Order History on the dashboard.',
    );
    expect(Copy.CASH_UP_PICK_MANAGER).toBe('Who is printing this?');
    expect(Copy.CASH_UP_PIN_PROMPT).toBe("{name}'s PIN");
    expect(Copy.CASH_UP_PIN_REASON).toBe(
      'The takings are only shown to a manager or owner, and the name goes on the printout.',
    );
    expect(Copy.CASH_UP_PRINT).toBe('Print cash-up');
    expect(Copy.CASH_UP_PRINTING).toBe('Printing…');
    expect(Copy.CASH_UP_NO_MANAGERS).toBe(
      'Nobody here can print the cash-up. A manager or owner has to be added in Settings first.',
    );
    expect(Copy.CASH_UP_REFUSED_PIN).toBe(
      'That PIN was not accepted, so nothing was printed. Check who is printing it and try again.',
    );
    expect(Copy.CASH_UP_NEEDS_AUTHORIZATION).toBe(
      'This terminal needs updating before it can print a cash-up. Nothing was printed.',
    );
    expect(Copy.CASH_UP_PRINTER_FAILED).toBe(
      'The cash-up was ready but the printer did not take it. Check the paper and try again — nothing has been recorded either way.',
    );
    expect(Copy.CASH_UP_NO_PRINTER).toBe(
      'No printer is set up on this terminal. Set one up in Settings, then try again.',
    );
    expect(Copy.CASH_UP_REPORT_FAILED).toBe(
      'The cash-up could not be worked out just now. Nothing was printed. Try again in a moment.',
    );
    expect(Copy.CASH_UP_PRINTED).toBe('Cash-up printed.');
    expect(Copy.CASH_UP_NOTHING_TAKEN).toBe(
      'Nothing was taken in that period. The printout will say so.',
    );
  });

  it('twenty strings, and no twenty-first added without a signature', () => {
    /**
     * THE COUNT IS TWENTY, AND IT WAS PRESENTED FOR SIGNATURE AS "19".
     *
     * The table sent to the owner contained all twenty rows — every string below was read and
     * signed — but the covering sentence miscounted them. The number is corrected here rather than
     * a string being dropped to match it, because what was signed is the LIST, not the total.
     * This assertion exists so the next person to add one has to get a signature.
     */
    const exported = Object.keys(Copy).filter(
      k => typeof (Copy as Record<string, unknown>)[k] === 'string',
    );
    expect(exported).toHaveLength(20);
  });

  it('every refusal tells the manager nothing printed', () => {
    /**
     * The load-bearing property. Owner at signing: "a manager who thinks the first press
     * half-worked will chase a phantom." Asserted over the SET, so a new refusal added later
     * without the reassurance fails here rather than in a venue.
     */
    for (const [name, text] of [
      ['CASH_UP_REFUSED_PIN', Copy.CASH_UP_REFUSED_PIN],
      ['CASH_UP_NEEDS_AUTHORIZATION', Copy.CASH_UP_NEEDS_AUTHORIZATION],
      ['CASH_UP_PRINTER_FAILED', Copy.CASH_UP_PRINTER_FAILED],
      ['CASH_UP_REPORT_FAILED', Copy.CASH_UP_REPORT_FAILED],
    ] as const) {
      expect({name, saysNothingPrinted: /nothing (was|has)/i.test(text)}).toEqual({
        name,
        saysNothingPrinted: true,
      });
    }
  });

  it('the printer failure says the RECORD is untouched, not merely that printing failed', () => {
    // The PIN was already spent and the report already built. "Try again" alone would leave a
    // manager thinking the first press did half of something.
    expect(Copy.CASH_UP_PRINTER_FAILED).toMatch(/nothing has been recorded either way/i);
  });

  it('the PIN prompt keeps its {name} slot', () => {
    // Without it the field reads "'s PIN" and the terminal goes to whoever is holding it.
    expect(Copy.CASH_UP_PIN_PROMPT).toContain('{name}');
  });

  it('the PIN reason says the name is kept, which is why it is asked for', () => {
    expect(Copy.CASH_UP_PIN_REASON).toMatch(/name/i);
    expect(Copy.CASH_UP_PIN_REASON).toMatch(/printout/i);
  });

  it('does not tell a manager to update the terminal, which they cannot do', () => {
    // Same ruling as the void copy, signed 2026-09-06.
    expect(Copy.CASH_UP_NEEDS_AUTHORIZATION).not.toMatch(/update the app/i);
    expect(Copy.CASH_UP_NEEDS_AUTHORIZATION).not.toMatch(/out of date/i);
  });

  it('the no-managers message does not promise a printout in the meantime', () => {
    expect(Copy.CASH_UP_NO_MANAGERS).toMatch(/Settings/);
    expect(Copy.CASH_UP_NO_MANAGERS).not.toMatch(/try again/i);
  });

  it('the period hint names where a longer range comes from', () => {
    // Otherwise a manager who wants last month concludes the feature is broken.
    expect(Copy.CASH_UP_PERIOD_HINT).toMatch(/Order History/);
  });

  it('the intro says what it is NOT, which is the whole reason that sentence exists', () => {
    // A document showing the day's takings with a venue name on it is exactly the thing somebody
    // might present as a receipt.
    expect(Copy.CASH_UP_INTRO).toMatch(/not a tax invoice/i);
  });

  it('nothing is left as a placeholder', () => {
    for (const [name, text] of Object.entries(Copy)) {
      if (typeof text !== 'string') continue;
      expect({name, placeholder: /PENDING|TODO|TBD|XXX/i.test(text)}).toEqual({
        name,
        placeholder: false,
      });
    }
  });
});
