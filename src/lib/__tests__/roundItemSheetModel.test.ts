/**
 * ONE ITEM, ONE NOTE — the basket model behind the item sheet.
 *
 * ================================================================================================
 * WHAT CHANGED AND WHY IT IS A MODEL TEST, NOT A SCREEN TEST
 * ================================================================================================
 *
 * Tapping an item used to add one un-noted unit, and the note was typed afterwards on the basket
 * row, with a Split button to peel a unit off when the note applied to only some of them. The
 * sheet asks for quantity and note at the moment of adding, and the per-unit case then falls out
 * of ONE RULE: addLine merges only into a line carrying the SAME note.
 *
 * That rule is what makes Split unnecessary, so it is asserted here rather than through the sheet.
 * A screen test would prove a modal renders; this proves two taps with different notes cannot
 * become one line.
 */
import {
  addLine,
  adjustLineQuantity,
  clampLineQuantity,
  MAX_LINE_QUANTITY,
  MAX_NOTE_LENGTH,
  MIN_LINE_QUANTITY,
} from '../serviceRound';

const cappuccino = {id: 'm1', name: 'Cappuccino', base_price: 30};
const steak = {id: 'm2', name: 'Ribeye', base_price: 220};

describe('a note belongs to what is being added', () => {
  it('two taps with DIFFERENT notes give two lines', () => {
    // The behaviour the Split button used to exist for.
    let lines = addLine([], cappuccino, {note: 'no sugar'});
    lines = addLine(lines, cappuccino, {note: 'extra hot'});

    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.note)).toEqual(['no sugar', 'extra hot']);
    expect(lines.every(l => l.quantity === 1)).toBe(true);
  });

  it('two taps with the SAME note merge, so the ordinary case stays one row', () => {
    let lines = addLine([], cappuccino, {note: 'no sugar'});
    lines = addLine(lines, cappuccino, {note: 'no sugar'});

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
  });

  it('two taps with NO note merge, which is the common case', () => {
    let lines = addLine([], cappuccino);
    lines = addLine(lines, cappuccino);

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
    expect(lines[0].note).toBe('');
  });

  it('a noted line is never merged into by an un-noted tap', () => {
    /**
     * The rule that protects the kitchen: merging would apply "well done" to a steak nobody asked
     * to be well done, and a wrong instruction reaching the pass is worse than an extra row.
     */
    let lines = addLine([], steak, {note: 'well done'});
    lines = addLine(lines, steak);

    expect(lines).toHaveLength(2);
    expect(lines[0].note).toBe('well done');
    expect(lines[1].note).toBe('');
  });

  it('whitespace is not a note, so " " still merges with none', () => {
    let lines = addLine([], cappuccino, {note: '   '});
    lines = addLine(lines, cappuccino, {note: ''});

    expect(lines).toHaveLength(1);
    expect(lines[0].note).toBe('');
  });

  it('carries the quantity chosen in the sheet, not always one', () => {
    const lines = addLine([], cappuccino, {quantity: 4, note: 'to share'});
    expect(lines[0].quantity).toBe(4);
    expect(lines[0].note).toBe('to share');
  });
});

describe('the clamp the QR sheet already enforces', () => {
  it('stops at the ceiling instead of building a line the server refuses', () => {
    // A waiter finding out at submit that 30 is refused, with a table waiting, is the failure the
    // customer's sheet prevents and the terminal did not.
    expect(clampLineQuantity(30)).toBe(MAX_LINE_QUANTITY);
    expect(clampLineQuantity(MAX_LINE_QUANTITY + 1)).toBe(MAX_LINE_QUANTITY);
  });

  it('never drops below one', () => {
    expect(clampLineQuantity(0)).toBe(MIN_LINE_QUANTITY);
    expect(clampLineQuantity(-5)).toBe(MIN_LINE_QUANTITY);
  });

  it('treats an unreadable quantity as one rather than as nothing', () => {
    expect(clampLineQuantity(NaN)).toBe(MIN_LINE_QUANTITY);
    /**
     * Infinity collapses to ONE, not to the ceiling. Both are "unreadable", and defaulting garbage
     * to the maximum would silently ring up twenty of something. Written down because the opposite
     * looks defensible until you say it out loud.
     */
    expect(clampLineQuantity(Infinity)).toBe(MIN_LINE_QUANTITY);
  });

  it('caps an add that would exceed the ceiling by merging', () => {
    let lines = addLine([], cappuccino, {quantity: 18});
    lines = addLine(lines, cappuccino, {quantity: 5});
    expect(lines[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it('the stepper also stops at the ceiling', () => {
    const lines = addLine([], cappuccino, {quantity: MAX_LINE_QUANTITY});
    const bumped = adjustLineQuantity(lines, lines[0].lineId, 1);
    expect(bumped[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it('but zero still REMOVES the row, which is the only way to delete from the stepper', () => {
    const lines = addLine([], cappuccino);
    expect(adjustLineQuantity(lines, lines[0].lineId, -1)).toHaveLength(0);
  });

  it('the note limit matches what a customer can type about the same dish', () => {
    // 280, the web repo's MAX_INSTRUCTIONS_LENGTH — not the 140 the old inline field imposed.
    expect(MAX_NOTE_LENGTH).toBe(280);
  });
});
