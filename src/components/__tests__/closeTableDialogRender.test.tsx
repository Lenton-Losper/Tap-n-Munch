/**
 * THE REFUSAL DIALOG AS A WAITER SEES IT (Ship 2b).
 *
 * closeTableRefusals.test.ts owns WHAT refuses and closeTableRefusalKind.test.ts owns WHICH KIND
 * each refusal is. This suite owns the three things only the rendered tree can answer, and each
 * one is a defect that shipped:
 *
 *   1. NO REASON IS HIDDEN. The list was a fixed-height ScrollView, so the third reason sat below
 *      the fold on a P5 and a waiter fixed two things only to be refused for one they were never
 *      shown. Past the visible limit the tail is COUNTED, and the count is asserted here.
 *
 *   2. RED STILL MEANS SOMETHING. Every reason rendered red, so "could not read the table" looked
 *      exactly like "the card may already have been charged". The tone is asserted by kind.
 *
 *   3. THE OVERRIDE IS OFFERED FOR MONEY AND NOTHING ELSE. A manager PIN reachable from "still
 *      being made" becomes the fast path staff reach for reflexively, which is how an override
 *      stops being a control. Owner's ruling, 2026-09-04.
 *
 * NOTHING HERE POSTS. Every api function is mocked; the assertions that expect a refusal also
 * assert closeTable and walkoutCloseTable were never called.
 */
import React from 'react';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockCloseTable = jest.fn();
const mockGetAuthorizedUsers = jest.fn();
const mockAuthorize = jest.fn();
const mockWalkoutClose = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTablesWithMeta: (...a: unknown[]) => mockGetTablesWithMeta(...a),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...a),
    closeTable: (...a: unknown[]) => mockCloseTable(...a),
    getAuthorizedUsers: (...a: unknown[]) => mockGetAuthorizedUsers(...a),
    authorizeTerminalAction: (...a: unknown[]) => mockAuthorize(...a),
    walkoutCloseTable: (...a: unknown[]) => mockWalkoutClose(...a),
    releaseStrandedRequest: jest.fn(async () => ({released: true, alreadyResolved: false})),
  };
});

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

jest.mock('../../context/ServiceSessionContext', () => ({
  useServiceSession: () => ({table: null, lines: [], endSession: jest.fn()}),
}));

import CloseTableAction from '../CloseTableAction';
import {
  CLOSE_REFUSED_DISMISS,
  CLOSE_REFUSED_MORE,
  CLOSE_TABLE_REFUSAL_COPY,
  WALKOUT_OFFER_BODY,
  WALKOUT_OFFER_TITLE,
} from '../../constants/closeTableCopy';
import {Colors} from '../../constants/theme';
import {TabLinesPayload} from '../../lib/tabLines';
import {TableWithTab} from '../../types';

const PLACED_AT = '2026-09-04T18:00:00.000Z';

type Line = TabLinesPayload['orders'][number]['lines'][number];

function line(over: Partial<Line> = {}): Line {
  return {
    id: 'line-1',
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'ready',
    bar_state: null,
    is_ready: true,
    is_voided: false,
    unrouted: false,
    ...over,
  } as Line;
}

/** A table that owes money and nothing else: the only shape that may offer the override. */
function owesMoneyOnly(unpaidTotal = 250): {table: TableWithTab; lines: TabLinesPayload} {
  return {
    table: {
      id: 'table-1',
      table_number: 5,
      status: 'occupied',
      can_close: true,
      tab: {
        id: 'tab-1',
        status: 'open',
        total: unpaidTotal,
        unpaid_total: unpaidTotal,
        orders: [
          {
            id: 'order-1',
            order_number: 41,
            total: unpaidTotal,
            status: 'completed',
            payment_status: 'unpaid',
            items: [],
            placed_at: PLACED_AT,
            card_payment_in_flight: false,
            card_in_flight_seconds: null,
          },
        ],
      },
    } as unknown as TableWithTab,
    lines: {
      tab: {
        id: 'tab-1',
        table_number: 5,
        status: 'open',
        total: unpaidTotal,
        opened_at: PLACED_AT,
        opened_by_user_id: 'user-1',
      },
      orders: [
        {
          order_id: 'order-1',
          order_number: 41,
          order_instructions: null,
          order_total: unpaidTotal,
          placed_at: PLACED_AT,
          seconds_since_placed: 900,
          lines: [line()],
        },
      ],
      summary: {total_lines: 1, outstanding: 0, ready: 1, voided: 0},
      all_ready: true,
      has_lines: true,
      server_time: null,
    } as unknown as TabLinesPayload,
  };
}

function serve(table: TableWithTab | null, lines: TabLinesPayload | null) {
  mockGetTablesWithMeta.mockResolvedValue({
    tables: table ? [table] : [],
    cardInFlightTimeoutSeconds: 120,
  });
  mockGetTabLines.mockResolvedValue(lines);
}

function renderedText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as {children?: unknown[]} | null)?.children;
    if (children) {
      children.forEach(walk);
    }
  };
  walk(json);
  return out.join('\n');
}

async function refuse(unsentRoundLineCount = 0) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <CloseTableAction
        tableId="table-1"
        tabId="tab-1"
        unsentRoundLineCount={unsentRoundLineCount}
        onClosed={jest.fn()}
      />,
    );
  });
  const button: ReactTestInstance = tree.root.findByProps({
    testID: 'close-table-button',
  });
  await act(async () => {
    await button.props.onPress();
  });
  return tree;
}

const has = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAllByProps({testID}).length > 0;

/** The colour actually handed to the first icon of a given kind. */
function iconColour(tree: renderer.ReactTestRenderer, kind: string): unknown {
  const found = tree.root.findAllByProps({testID: `close-refusal-icon-${kind}`});
  expect(found.length).toBeGreaterThan(0);
  return found[0].props.color;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthorizedUsers.mockResolvedValue([{user_id: 'mgr-1', name: 'Ana'}]);
});

describe('the override is offered for money and nothing else', () => {
  it('offers it when money is the only blocker', async () => {
    const {table, lines} = owesMoneyOnly();
    serve(table, lines);
    const tree = await refuse();
    expect(has(tree, 'close-table-refusal-sheet')).toBe(true);
    expect(has(tree, 'walkout-override')).toBe(true);
    expect(renderedText(tree.toJSON())).toContain(WALKOUT_OFFER_TITLE);
    expect(mockCloseTable).not.toHaveBeenCalled();
    expect(mockWalkoutClose).not.toHaveBeenCalled();
  });

  it('shows the server figure, so the manager sees the number before the PIN', async () => {
    const {table, lines} = owesMoneyOnly(432.5);
    serve(table, lines);
    const tree = await refuse();
    expect(renderedText(tree.toJSON())).toContain(
      WALKOUT_OFFER_BODY.replace('{amount}', 'N$432.50'),
    );
  });

  it('drops the amount sentence rather than claiming N$0.00 when the figure is unreadable', async () => {
    const {table, lines} = owesMoneyOnly();
    // ORDER_OWES_MONEY still refuses; unpaid_total does not resolve to a figure.
    (table.tab as unknown as {unpaid_total: unknown}).unpaid_total = null;
    serve(table, lines);
    const tree = await refuse();
    const text = renderedText(tree.toJSON());
    expect(has(tree, 'walkout-override')).toBe(true);
    expect(text).not.toContain('N$0.00');
    expect(text).toContain(
      WALKOUT_OFFER_BODY.slice(0, WALKOUT_OFFER_BODY.indexOf('{amount}')).trim(),
    );
  });

  it('withholds it when a non-money blocker is also present', async () => {
    const {table, lines} = owesMoneyOnly();
    lines.orders[0].lines = [line({is_ready: false, kitchen_state: 'preparing'})];
    (lines as unknown as {all_ready: boolean}).all_ready = false;
    serve(table, lines);
    const tree = await refuse();
    expect(has(tree, 'close-table-refusal-sheet')).toBe(true);
    expect(has(tree, 'walkout-override')).toBe(false);
    expect(renderedText(tree.toJSON())).not.toContain(WALKOUT_OFFER_TITLE);
  });

  it('withholds it when the device cannot read the table at all', async () => {
    serve(null, null);
    const tree = await refuse();
    expect(has(tree, 'walkout-override')).toBe(false);
  });
});

describe('no reason is hidden', () => {
  it('counts the tail instead of dropping it below a fold', async () => {
    const {table, lines} = owesMoneyOnly();
    (table as unknown as {can_close: boolean}).can_close = false; // SERVER_REFUSES
    // OUTSTANDING_LINE and UNROUTED_LINE together.
    lines.orders[0].lines = [line({is_ready: false, unrouted: true})];
    (lines as unknown as {all_ready: boolean}).all_ready = false;
    serve(table, lines);
    const tree = await refuse(1); // UNSENT_ROUND_ON_DEVICE
    // Six fire; four render in full and the remaining two are counted, never silently dropped.
    expect(has(tree, 'close-refusal-more')).toBe(true);
    expect(renderedText(tree.toJSON())).toContain(
      CLOSE_REFUSED_MORE.replace('{count}', '2'),
    );
  });

  it('does not count a tail when everything fits', async () => {
    const {table, lines} = owesMoneyOnly();
    serve(table, lines);
    const tree = await refuse();
    expect(has(tree, 'close-refusal-more')).toBe(false);
    expect(renderedText(tree.toJSON())).toContain(
      CLOSE_TABLE_REFUSAL_COPY.UNPAID_BALANCE,
    );
  });
});

describe('red still means something', () => {
  it('renders an unreadable table as broken, not as an alarm', async () => {
    serve(null, null);
    const tree = await refuse();
    expect(has(tree, 'close-refusal-icon-broken')).toBe(true);
    expect(has(tree, 'close-refusal-icon-alarming')).toBe(false);
    // The COLOUR, not just the kind: a tone map that painted everything red would satisfy the
    // testIDs above and reproduce the exact defect this dialog was rebuilt to fix.
    expect(iconColour(tree, 'broken')).not.toBe(Colors.red);
  });

  it('keeps the alarm for a card that may already have been charged', async () => {
    const {table, lines} = owesMoneyOnly();
    const order = (table.tab as unknown as {
      orders: {card_payment_in_flight: boolean; card_in_flight_seconds: number}[];
    }).orders[0];
    order.card_payment_in_flight = true;
    order.card_in_flight_seconds = 600; // past the 120s timeout: STUCK
    serve(table, lines);
    const tree = await refuse();
    expect(has(tree, 'close-refusal-icon-alarming')).toBe(true);
    expect(iconColour(tree, 'alarming')).toBe(Colors.red);
  });
});

it('the dismiss button dismisses and says so', async () => {
  const {table, lines} = owesMoneyOnly();
  serve(table, lines);
  const tree = await refuse();
  expect(renderedText(tree.toJSON())).toContain(CLOSE_REFUSED_DISMISS);
  const dismiss: ReactTestInstance = tree.root.findByProps({
    testID: 'close-refusal-dismiss',
  });
  await act(async () => {
    dismiss.props.onPress();
  });
  expect(has(tree, 'close-table-refusal-sheet')).toBe(false);
  expect(mockCloseTable).not.toHaveBeenCalled();
});
