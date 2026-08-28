/**
 * THE AMEND WINDOW, AND THE FACT THAT THE SERVER OWNS IT.
 *
 * `canAmendLine` is an affordance: it stops the screen offering an edit that is certainly doomed.
 * It is NOT the rule. The rule lives in amend_order_lines (migration 20260829150000), which the
 * route calls in one transaction, and which refuses per line.
 *
 * These bind to the window as the SQL function defines it — outstanding at every station that owns
 * the line — so that a change to this helper cannot quietly start offering edits the server will
 * refuse, or hiding edits it would have allowed.
 */
import {canAmendLine, nothingApplied, type AmendResult} from '../amendTabLines';

describe('canAmendLine — the window the server enforces', () => {
  it('opens a kitchen-only line that is outstanding', () => {
    expect(canAmendLine({kitchen_state: 'outstanding', bar_state: null})).toBe(true);
  });

  it('opens a bar-only line that is outstanding', () => {
    expect(canAmendLine({kitchen_state: null, bar_state: 'outstanding'})).toBe(true);
  });

  it('closes the moment the kitchen has cooked it', () => {
    expect(canAmendLine({kitchen_state: 'cooked', bar_state: null})).toBe(false);
  });

  it('closes when it is ready', () => {
    expect(canAmendLine({kitchen_state: 'ready', bar_state: null})).toBe(false);
  });

  /**
   * THE HALF-COOKED ROUND, which is why the owner ruled the refusal is PER LINE.
   *
   * A 'both'-routed line is owned by two stations. One of them starting it closes the window even
   * though the other has not — the food is already being made, and voiding it would take a plate
   * off a station mid-prep.
   */
  it('closes a both-routed line when EITHER station has started it', () => {
    expect(canAmendLine({kitchen_state: 'cooked', bar_state: 'outstanding'})).toBe(false);
    expect(canAmendLine({kitchen_state: 'outstanding', bar_state: 'ready'})).toBe(false);
  });

  it('stays open while BOTH stations are still outstanding', () => {
    expect(canAmendLine({kitchen_state: 'outstanding', bar_state: 'outstanding'})).toBe(true);
  });

  it('never offers to amend a line that is already voided', () => {
    expect(canAmendLine({is_voided: true, kitchen_state: 'outstanding', bar_state: null})).toBe(
      false,
    );
  });

  /**
   * A line no station owns is unrouted — nobody is making it, and the SQL function's own guard
   * (`kitchen_state IS NOT NULL OR bar_state IS NOT NULL`) excludes it. Offering an edit here
   * would produce a refusal every time.
   */
  it('does not offer to amend a line no station owns', () => {
    expect(canAmendLine({kitchen_state: null, bar_state: null})).toBe(false);
  });
});

describe('nothingApplied — a 200 that changed nothing is not a success', () => {
  const result = (over: Partial<AmendResult>): AmendResult => ({
    order_id: null,
    order_number: null,
    applied: [],
    refused: [],
    ...over,
  });

  /**
   * THE RACE. The waiter pressed while the kitchen was tapping Cooked. The response is a 200, and
   * the tab is completely unchanged — if this read as success the screen would tell the waiter an
   * item came off an order the customer is still going to be charged for.
   */
  it('is true when every line was refused', () => {
    expect(
      nothingApplied(result({refused: [{line_id: 'l1', reason: 'window_closed'}]})),
    ).toBe(true);
  });

  it('CONTROL: is false when something actually changed', () => {
    expect(
      nothingApplied(
        result({
          order_id: 'o-9',
          order_number: 42,
          applied: [{line_id: 'l1', action: 'replaced', new_line_id: 'l2'}],
        }),
      ),
    ).toBe(false);
  });

  /**
   * A partial result is NOT "nothing applied" — some food changed and some did not, and the screen
   * must refetch rather than showing a refusal-only sheet.
   */
  it('CONTROL: is false when one line applied and another was refused', () => {
    expect(
      nothingApplied(
        result({
          applied: [{line_id: 'l1', action: 'voided'}],
          refused: [{line_id: 'l2', reason: 'window_closed'}],
        }),
      ),
    ).toBe(false);
  });

  it('is false for an empty result, which is not a refusal', () => {
    expect(nothingApplied(result({}))).toBe(false);
  });
});
