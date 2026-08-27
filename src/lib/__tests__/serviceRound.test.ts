/**
 * Pins the parts of waiter-led service that a screen cannot be trusted to keep right: how a basket
 * line is identified, and what shape leaves the device on POST /api/terminal/rounds.
 */
import {
  addLine,
  adjustLineQuantity,
  basketCount,
  basketSubtotal,
  buildRoundItems,
  formatSecondsOpen,
  newRoundIdempotencyKey,
  outOfStockLineIds,
  removeLine,
  RoundLine,
  setLineNote,
  splitLine,
} from '../serviceRound';

const ribeye = {id: 'm-1', name: 'Ribeye', base_price: 214};
const coke = {id: 'm-2', name: 'Coke', base_price: 25};

describe('formatSecondsOpen', () => {
  it('renders the brief\'s two examples', () => {
    expect(formatSecondsOpen(4500)).toBe('1h 15m');
    expect(formatSecondsOpen(1200)).toBe('20m');
  });

  it('is blank for a free table', () => {
    expect(formatSecondsOpen(null)).toBe('');
    expect(formatSecondsOpen(undefined)).toBe('');
  });

  it('does not render a negative or non-finite server value', () => {
    expect(formatSecondsOpen(-1)).toBe('');
    expect(formatSecondsOpen(Number.NaN)).toBe('');
  });
});

describe('basket lines', () => {
  it('merges a repeat tap into the existing un-noted line', () => {
    const lines = addLine(addLine([], ribeye), ribeye);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
  });

  /**
   * The rule that matters. Merging into a noted line would apply "well done" to a steak nobody
   * asked to be well done — a wrong instruction reaching the kitchen is worse than an extra row.
   */
  it('starts a new line rather than inheriting another line\'s note', () => {
    let lines = addLine([], ribeye);
    lines = setLineNote(lines, lines[0].lineId, 'well done');
    lines = addLine(lines, ribeye);

    expect(lines).toHaveLength(2);
    expect(lines[0].note).toBe('well done');
    expect(lines[1].note).toBe('');
    expect(lines[0].lineId).not.toBe(lines[1].lineId);
  });

  it('splits one unit off a line so two of the same dish can differ', () => {
    let lines = addLine(addLine([], ribeye), ribeye);
    lines = splitLine(lines, lines[0].lineId);

    expect(lines).toHaveLength(2);
    expect(lines[0].quantity).toBe(1);
    expect(lines[1].quantity).toBe(1);
    expect(lines[0].lineId).not.toBe(lines[1].lineId);

    lines = setLineNote(lines, lines[1].lineId, 'rare');
    expect(lines[0].note).toBe('');
    expect(lines[1].note).toBe('rare');
  });

  it('will not split a single unit', () => {
    const lines = addLine([], ribeye);
    expect(splitLine(lines, lines[0].lineId)).toEqual(lines);
  });

  it('removes a line driven to zero rather than leaving an empty row', () => {
    const lines = addLine([], coke);
    expect(adjustLineQuantity(lines, lines[0].lineId, -1)).toEqual([]);
  });

  it('removes by lineId, not by menu item', () => {
    let lines = addLine([], ribeye);
    lines = setLineNote(lines, lines[0].lineId, 'rare');
    lines = addLine(lines, ribeye);

    const kept = removeLine(lines, lines[0].lineId);
    expect(kept).toHaveLength(1);
    expect(kept[0].note).toBe('');
  });

  it('counts units and money across lines', () => {
    let lines = addLine(addLine([], ribeye), coke);
    lines = adjustLineQuantity(lines, lines[0].lineId, 1);
    expect(basketCount(lines)).toBe(3);
    expect(basketSubtotal(lines)).toBe(214 * 2 + 25);
  });
});

describe('buildRoundItems', () => {
  it('sends `note` singular, and omits it when blank', () => {
    let lines = addLine(addLine([], ribeye), coke);
    lines = setLineNote(lines, lines[0].lineId, '  medium  ');

    const items = buildRoundItems(lines);
    expect(items).toEqual([
      {menuItemId: 'm-1', name: 'Ribeye', quantity: 1, note: 'medium'},
      {menuItemId: 'm-2', name: 'Coke', quantity: 1},
    ]);
    expect(Object.keys(items[1])).not.toContain('note');
  });

  /**
   * An item with no menuItemId is accepted by the server and lands as `unrouted` on BOTH station
   * screens. Sending one is choosing to create a routing problem for a kitchen.
   */
  it('drops a line with no menuItemId instead of sending it unrouted', () => {
    const lines: RoundLine[] = [
      {
        lineId: 'l1',
        menuItemId: '',
        name: 'Mystery',
        unitPrice: 10,
        quantity: 1,
        note: '',
      },
    ];
    expect(buildRoundItems(lines)).toEqual([]);
  });
});

describe('outOfStockLineIds', () => {
  it('flags every refused item at once, matching by name', () => {
    let lines = addLine(addLine([], ribeye), coke);
    lines = splitLine(addLine(lines, ribeye), lines[0].lineId);

    const flagged = outOfStockLineIds(lines, [
      {item: ' ribeye '},
      {item: 'Coke'},
    ]);
    expect(flagged.length).toBe(lines.length);
  });

  it('flags nothing when the server named nothing', () => {
    const lines = addLine([], ribeye);
    expect(outOfStockLineIds(lines, [])).toEqual([]);
    expect(outOfStockLineIds(lines, [{item: ''}])).toEqual([]);
  });
});

describe('newRoundIdempotencyKey', () => {
  it('is distinct per call — one key per ROUND, never per request', () => {
    expect(newRoundIdempotencyKey()).not.toBe(newRoundIdempotencyKey());
  });

  it('names the flow that produced it', () => {
    expect(newRoundIdempotencyKey().startsWith('round_')).toBe(true);
  });
});
