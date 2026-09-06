/**
 * THE SIGNED ITEM SHEET COPY. SIGNED BY THE OWNER 2026-09-06.
 *
 * Eight strings, every one shown to a waiter mid-service with a table waiting. Pinned as written so
 * a tidy-up, a refactor, or someone "improving" a sentence fails here rather than silently changing
 * what is read at a table.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review: get the new
 * wording signed, change the constants in the same commit as this file, and say who signed it and
 * when.
 *
 * ============================================================================================
 * THE ONE EDIT AT SIGNING, AND THE RULE BEHIND IT
 * ============================================================================================
 *
 * ITEM_SHEET_NOTE_HINT was drafted as "This note goes to the kitchen for everything you add here.
 * For a different note, add it separately."
 *
 * Owner: "'everything you add here' is vague about what 'here' means, and 'For a different note,
 * add it separately' reads as an instruction without saying what it achieves. The rewrite says what
 * happens and what to do instead."
 *
 * That is the house rule for this whole file, so it is asserted as a property below and not only as
 * a string: the hint must state the CONSEQUENCE, not merely give an instruction.
 */
import * as Copy from '../../constants/roundItemSheetCopy';

const SIGNED_ON = '2026-09-06';

describe(`the signed item sheet copy (signed ${SIGNED_ON})`, () => {
  it('reads exactly as signed', () => {
    expect(Copy.ITEM_SHEET_NOTE_LABEL).toBe('Note for the kitchen');
    expect(Copy.ITEM_SHEET_NOTE_PLACEHOLDER).toBe('e.g. medium rare, no onions');
    expect(Copy.ITEM_SHEET_NOTE_HINT).toBe(
      'This note goes to the kitchen for all of them. Add separately if they need different notes.',
    );
    expect(Copy.ITEM_SHEET_QUANTITY_LABEL).toBe('How many?');
    expect(Copy.ITEM_SHEET_QUANTITY_CAPPED).toBe(
      'Up to {max} at a time. Add another round for more.',
    );
    expect(Copy.ITEM_SHEET_ADD).toBe('Add to round');
    expect(Copy.ITEM_SHEET_CANCEL).toBe('Cancel — nothing added');
    expect(Copy.ITEM_SHEET_SAVE).toBe('Save changes');
  });

  it('eight strings, and no ninth added without a signature', () => {
    const exported = Object.keys(Copy).filter(
      k => typeof (Copy as Record<string, unknown>)[k] === 'string',
    );
    expect(exported).toHaveLength(8);
  });
});

describe('the properties the wording was signed FOR', () => {
  it('the hint says what HAPPENS, not just what to do', () => {
    /**
     * The owner's edit. "Add separately" alone is an instruction with no stated effect; the signed
     * wording names the consequence first — the note reaches the kitchen for ALL of them — which is
     * the fact that makes the instruction make sense.
     */
    expect(Copy.ITEM_SHEET_NOTE_HINT).toMatch(/goes to the kitchen/i);
    expect(Copy.ITEM_SHEET_NOTE_HINT).toMatch(/all of them/i);
    // And the vague draft wording must not come back.
    expect(Copy.ITEM_SHEET_NOTE_HINT).not.toMatch(/everything you add here/i);
  });

  it('the cancel says nothing was added, rather than a bare Cancel', () => {
    /**
     * Owner at signing: "the ambiguity of a bare Cancel mid-service is worth the extra words." A
     * waiter half-way through a round must not have to wonder whether backing out of the sheet
     * removed the item or never added it.
     */
    expect(Copy.ITEM_SHEET_CANCEL).not.toBe('Cancel');
    expect(Copy.ITEM_SHEET_CANCEL).toMatch(/nothing added/i);
  });

  it('the note label names WHO reads it', () => {
    // "Note" alone gets used for things the kitchen never sees.
    expect(Copy.ITEM_SHEET_NOTE_LABEL).toMatch(/kitchen/i);
  });

  it('the confirm names the basket, so it is not a bare OK', () => {
    expect(Copy.ITEM_SHEET_ADD).toMatch(/round/i);
    expect(Copy.ITEM_SHEET_ADD).not.toBe('OK');
    // And editing an existing line says Save, because "Add" on a line already in the round would
    // read as a second helping.
    expect(Copy.ITEM_SHEET_SAVE).not.toBe(Copy.ITEM_SHEET_ADD);
  });

  it('the quantity cap keeps its {max} slot and says what to do', () => {
    // Without the slot it renders a literal; without the second sentence it is a dead end.
    expect(Copy.ITEM_SHEET_QUANTITY_CAPPED).toContain('{max}');
    expect(Copy.ITEM_SHEET_QUANTITY_CAPPED).toMatch(/another round/i);
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
