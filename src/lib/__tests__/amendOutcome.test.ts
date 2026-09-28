/**
 * WHAT COUNTS AS "IT CAME OFF THE BILL". (Sprint 2026-09-28 brief, contract C3.)
 *
 * Riviera Table 1, order #160: a tester believed Modena Pasta N$240 was cancelled; the server had
 * recorded nothing, and it was cooked. The rule these pin is the whole fix in one sentence: a line
 * is cancelled or reduced ONLY when the server's `applied` contains its line_id. Everything else —
 * refused, missing from both arrays, a malformed body — is not a cancellation.
 */
import {
  amountOffCents,
  lineAmendOutcome,
  nothingApplied,
  parseAmendResult,
} from '../amendTabLines';

const L1 = 'line-1';
const L2 = 'line-2';
const req = (lineId: string, previousQuantity: number, requestedQuantity: number) => ({
  lineId,
  previousQuantity,
  requestedQuantity,
});

describe('parseAmendResult — strict, so a bad body can never read as success', () => {
  it('reads an old-server body (no changed, no lines) and keeps working via applied', () => {
    const r = parseAmendResult({
      success: true,
      order_id: null,
      order_number: null,
      applied: [{line_id: L1, action: 'voided'}],
      refused: [],
    });
    expect(r.well_formed).toBe(true);
    expect(r.changed).toBeUndefined();
    expect(r.lines).toBeUndefined();
    expect(lineAmendOutcome(r, req(L1, 1, 0))).toMatchObject({kind: 'confirmed', effect: 'removed'});
  });

  it('reads the C3 body, and uses `lines` only to decorate a confirmation', () => {
    const r = parseAmendResult({
      success: true,
      changed: true,
      order_id: 'o-9',
      order_number: 44,
      applied: [{line_id: L1, action: 'replaced', new_line_id: 'l1b'}],
      refused: [],
      lines: [{line_id: L1, name: 'Burger', outcome: 'reduced', previous_quantity: 3, quantity: 1}],
    });
    expect(r.changed).toBe(true);
    // The server's quantity wins over the requested one.
    expect(lineAmendOutcome(r, req(L1, 3, 2))).toEqual({
      kind: 'confirmed',
      lineId: L1,
      effect: 'reduced',
      quantity: 1,
      previousQuantity: 3,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an empty object', {}],
    ['success without arrays', {success: true, changed: true}],
    ['applied not an array', {applied: {line_id: L1}, refused: []}],
    ['refused missing', {applied: [{line_id: L1}]}],
  ])('marks %s as NOT well formed, and not confirmed', (_label, body) => {
    const r = parseAmendResult(body);
    expect(r.well_formed).toBe(false);
    expect(nothingApplied(r)).toBe(true);
    expect(lineAmendOutcome(r, req(L1, 1, 0))).toEqual({
      kind: 'not_confirmed',
      lineId: L1,
      why: 'malformed',
    });
  });
});

describe('lineAmendOutcome — confirmed ONLY by applied', () => {
  it('a line refused as window_closed (already cooked) is refused, not removed', () => {
    const r = parseAmendResult({applied: [], refused: [{line_id: L1, reason: 'window_closed'}]});
    expect(lineAmendOutcome(r, req(L1, 1, 0))).toEqual({
      kind: 'refused',
      lineId: L1,
      reason: 'window_closed',
    });
  });

  it.each(['order_paid', 'line_settled', 'not_found', 'invalid_quantity', 'something_new'])(
    'carries the refusal reason %s through verbatim',
    reason => {
      const r = parseAmendResult({applied: [], refused: [{line_id: L1, reason}]});
      expect(lineAmendOutcome(r, req(L1, 2, 0))).toMatchObject({kind: 'refused', reason});
    },
  );

  it('a 200 that mentions the line NOWHERE is not confirmed', () => {
    const r = parseAmendResult({applied: [], refused: []});
    expect(lineAmendOutcome(r, req(L1, 1, 0))).toEqual({
      kind: 'not_confirmed',
      lineId: L1,
      why: 'absent',
    });
  });

  it('`changed: true` and a `lines` entry cannot confirm a line that is not in applied', () => {
    const r = parseAmendResult({
      changed: true,
      applied: [],
      refused: [],
      lines: [{line_id: L1, outcome: 'voided', previous_quantity: 1, quantity: 0}],
    });
    expect(lineAmendOutcome(r, req(L1, 1, 0)).kind).toBe('not_confirmed');
  });

  it('PARTIAL: one line applied, one refused — each is told its own truth', () => {
    const r = parseAmendResult({
      applied: [{line_id: L1, action: 'voided'}],
      refused: [{line_id: L2, reason: 'window_closed'}],
    });
    expect(lineAmendOutcome(r, req(L1, 1, 0)).kind).toBe('confirmed');
    expect(lineAmendOutcome(r, req(L2, 1, 0))).toMatchObject({
      kind: 'refused',
      reason: 'window_closed',
    });
  });

  it('another line applied does not confirm this one', () => {
    const r = parseAmendResult({applied: [{line_id: L2, action: 'voided'}], refused: []});
    expect(lineAmendOutcome(r, req(L1, 1, 0)).kind).toBe('not_confirmed');
  });

  it('drops entries with no line_id rather than guessing', () => {
    const r = parseAmendResult({applied: [{action: 'voided'}, {line_id: ''}], refused: []});
    expect(r.applied).toEqual([]);
  });
});

describe('amountOffCents — the figure in the confirmation sentence', () => {
  it('a removal takes the whole line total', () => {
    expect(amountOffCents(24000, 1, 0)).toBe(24000);
  });
  it('3 to 1 takes two thirds', () => {
    expect(amountOffCents(36000, 3, 1)).toBe(24000);
  });
  it('names no figure when the server sent no price', () => {
    expect(amountOffCents(null, 1, 0)).toBeNull();
    expect(amountOffCents(undefined, 1, 0)).toBeNull();
  });
  it('names no figure for an increase', () => {
    expect(amountOffCents(1000, 1, 2)).toBeNull();
  });
});
