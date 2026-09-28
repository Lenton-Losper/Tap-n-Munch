/**
 * A FULLY VOIDED ORDER MUST NOT KEEP A TABLE OPEN FOREVER -- and a guess must not close one.
 *
 * Sprint 2026-09-28. Amend never touches payment_status, so a fully voided order sits `pending`
 * over a bill of N$0. Rules 6 (ORDER_OWES_MONEY) and 11 (LINE_TRACKING_UNAVAILABLE) asked only
 * `owesMoney(payment_status)` and so refused the close for good, although the server no longer
 * does. They now accept the SERVER's outstanding_cents of 0 -- and only the server's.
 */
import {evaluateCloseTableRefusals, type CloseTableSnapshot} from '../closeTableRefusals';
import type {TableWithTab} from '../../types';
import {line, money, payloadWith} from './helpers/linesPayload';

const VOIDED_ORDER = {
  id: 'voided',
  order_number: 7,
  total: 120,
  status: 'completed',
  payment_status: 'pending',
  items: [],
  placed_at: '2026-09-28T18:00:00.000Z',
  can_settle_card: true,
  can_settle_cash: true,
  card_payment_in_flight: false,
  card_in_flight_seconds: null,
};

function table(orderExtra: Record<string, unknown> = {}): TableWithTab {
  return {
    id: 'table-1',
    table_number: 5,
    status: 'occupied',
    can_close: true,
    tab: {
      id: 'tab-1',
      status: 'settled',
      total: 0,
      unpaid_total: 0,
      orders: [{...VOIDED_ORDER, ...orderExtra}],
    },
  } as unknown as TableWithTab;
}

const voidedLines = (withFinancials: boolean) => {
  const p = payloadWith(
    [{id: 'voided', total: 120, lines: [line({cents: 12000, voided: true})]}],
    withFinancials
      ? {
          tab: money({original_cents: 12000, voided_cents: 12000}),
          orders: {voided: money({original_cents: 12000, voided_cents: 12000})},
        }
      : undefined,
  );
  return {...p, tab: {...p.tab, status: 'settled'}, all_ready: true};
};

const snapshot = (over: Partial<CloseTableSnapshot>): CloseTableSnapshot => ({
  table: table(),
  lines: voidedLines(false),
  cardInFlightTimeoutSeconds: 120,
  unsentRoundLineCount: 0,
  ...over,
});

describe('rule 6, ORDER_OWES_MONEY', () => {
  it('does not refuse when /api/terminal/tables says the order owes 0', () => {
    const s = snapshot({table: table({financials: money({original_cents: 12000, voided_cents: 12000})})});
    expect(evaluateCloseTableRefusals(s)).not.toContain('ORDER_OWES_MONEY');
  });

  it('does not refuse when the lines payload financials say the order owes 0', () => {
    const s = snapshot({lines: voidedLines(true)});
    expect(evaluateCloseTableRefusals(s)).not.toContain('ORDER_OWES_MONEY');
  });

  it('STILL refuses on a figure the device derived itself (older server)', () => {
    // The lines prove every line voided, but no SERVER figure says 0 -- a guess never closes a table.
    expect(evaluateCloseTableRefusals(snapshot({}))).toContain('ORDER_OWES_MONEY');
  });

  it('STILL refuses when the server says something is outstanding', () => {
    const s = snapshot({
      table: table({financials: money({original_cents: 12000, voided_cents: 2000})}),
    });
    expect(evaluateCloseTableRefusals(s)).toContain('ORDER_OWES_MONEY');
  });

  it('an unreadable financials block is ignored, not read as 0', () => {
    const s = snapshot({table: table({financials: {outstanding_cents: 0}})});
    expect(evaluateCloseTableRefusals(s)).toContain('ORDER_OWES_MONEY');
  });
});

describe('rule 11, LINE_TRACKING_UNAVAILABLE (a QR tab with no lines)', () => {
  const noLines = () => ({...payloadWith([]), tab: {...payloadWith([]).tab, status: 'settled'}});

  it('closes a line-less tab whose only order the server says owes 0', () => {
    const s = snapshot({
      table: table({financials: money({original_cents: 12000, voided_cents: 12000})}),
      lines: noLines(),
    });
    expect(evaluateCloseTableRefusals(s)).not.toContain('LINE_TRACKING_UNAVAILABLE');
  });

  it('refuses the same tab when no server figure is present', () => {
    const s = snapshot({lines: noLines()});
    expect(evaluateCloseTableRefusals(s)).toContain('LINE_TRACKING_UNAVAILABLE');
  });
});
