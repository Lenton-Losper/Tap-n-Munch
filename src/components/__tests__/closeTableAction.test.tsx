/**
 * THE WIRING BETWEEN THE REFUSAL SET AND THE REQUEST.
 *
 * closeTableRefusals.test.ts owns "what refuses". This suite owns the two things a pure test
 * cannot reach, both of which are the difference between a safe control and a decorative one:
 *
 *   1. A REFUSAL ACTUALLY STOPS THE POST. A refusal set that is computed and then not consulted is
 *      the #306 shape — a value produced and never selected. Every assertion below that expects a
 *      refusal also asserts that `closeTable` was never called.
 *
 *   2. NOTHING CLOSES A TABLE ON ITS OWN. Settling does not end a session and paid is not closed,
 *      so this control must only ever fire from a deliberate press. The "not auto-closed" tests
 *      mount the component over a fully paid, fully settled, fully ready table — the exact state
 *      an over-eager implementation would treat as "done, close it" — and assert that nothing is
 *      sent, and that even one press only reaches a confirmation.
 *
 * NO NETWORK. lib/api is mocked over jest.requireActual so ApiRequestError stays the real class —
 * the 409 branch turns on `instanceof`, and a stand-in error would let a broken branch pass.
 */
import React from 'react';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockCloseTable = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTablesWithMeta: (...args: unknown[]) => mockGetTablesWithMeta(...args),
    getTabLines: (...args: unknown[]) => mockGetTabLines(...args),
    closeTable: (...args: unknown[]) => mockCloseTable(...args),
    releaseStrandedRequest: jest.fn(async () => ({
      released: true,
      alreadyResolved: false,
    })),
  };
});

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

const mockEndSession = jest.fn();
let mockSessionTable: {tabId: string} | null = null;

jest.mock('../../context/ServiceSessionContext', () => ({
  useServiceSession: () => ({
    table: mockSessionTable,
    lines: [],
    endSession: mockEndSession,
  }),
}));

import CloseTableAction from '../CloseTableAction';
import {ApiRequestError} from '../../lib/api';
import {
  CLOSE_CONFIRM_TITLE,
  CLOSE_REFUSED_TITLE,
  CLOSE_TABLE_REFUSAL_COPY,
} from '../../constants/closeTableCopy';
import {TabLinesPayload} from '../../lib/tabLines';
import {TableWithTab} from '../../types';

const PLACED_AT = '2026-08-27T18:00:00.000Z';

/** A table at the end of service: every order paid, the tab settled, every line ready. */
function settledAndReady(): {table: TableWithTab; lines: TabLinesPayload} {
  return {
    table: {
      id: 'table-1',
      table_number: 5,
      status: 'occupied',
      can_close: true,
      tab: {
        id: 'tab-1',
        status: 'settled',
        total: 200,
        unpaid_total: 0,
        orders: [
          {
            id: 'order-1',
            order_number: 41,
            total: 200,
            status: 'completed',
            payment_status: 'paid',
            items: [],
            placed_at: PLACED_AT,
            card_payment_in_flight: false,
            card_in_flight_seconds: null,
          },
        ],
      },
    },
    lines: {
      tab: {
        id: 'tab-1',
        table_number: 5,
        status: 'settled',
        total: 200,
        opened_at: PLACED_AT,
        opened_by_user_id: 'user-1',
      },
      orders: [
        {
          order_id: 'order-1',
          order_number: 41,
          order_instructions: null,
          order_total: 200,
          placed_at: PLACED_AT,
          seconds_since_placed: 900,
          lines: [
            {
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
            },
          ],
        },
      ],
      summary: {total_lines: 1, outstanding: 0, ready: 1, voided: 0},
      all_ready: true,
      has_lines: true,
      server_time: null,
    },
  };
}

function serve(table: TableWithTab | null, lines: TabLinesPayload | null) {
  mockGetTablesWithMeta.mockResolvedValue({
    tables: table ? [table] : [],
    cardInFlightTimeoutSeconds: 120,
  });
  if (lines) {
    mockGetTabLines.mockResolvedValue(lines);
  } else {
    mockGetTabLines.mockRejectedValue(new Error('unreadable'));
  }
}

/** Every string in the rendered tree — what a waiter is actually looking at. */
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

async function mount(onClosed = jest.fn()) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <CloseTableAction
        tableId="table-1"
        tabId="tab-1"
        unsentRoundLineCount={0}
        onClosed={onClosed}
      />,
    );
  });
  return tree;
}

async function press(tree: renderer.ReactTestRenderer, testID: string) {
  const node: ReactTestInstance = tree.root.findByProps({testID});
  await act(async () => {
    await node.props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionTable = null;
  mockCloseTable.mockResolvedValue(undefined);
});

describe('nothing closes a table on its own', () => {
  /**
   * THE ASSERTION THE WHOLE FEATURE TURNS ON. This is the state an implementation that confused
   * settlement with closure would act on unprompted: nothing owed, nothing cooking, tab settled.
   */
  it('a paid and settled table is not closed by mounting the control', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    await mount();
    expect(mockCloseTable).not.toHaveBeenCalled();
    expect(mockGetTablesWithMeta).not.toHaveBeenCalled();
  });

  it('one press on a closeable table asks for confirmation and still sends nothing', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    expect(renderedText(tree.toJSON())).toContain(CLOSE_CONFIRM_TITLE);
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  it('backing out of the confirmation sends nothing', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-cancel');
    expect(mockCloseTable).not.toHaveBeenCalled();
  });
});

describe('a settled tab is still closeable', () => {
  it('confirming sends the close for the table, once', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    const onClosed = jest.fn();
    const tree = await mount(onClosed);
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-confirm');
    expect(mockCloseTable).toHaveBeenCalledTimes(1);
    expect(mockCloseTable).toHaveBeenCalledWith('table-1', 'terminal-token');
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('drops the device session when it was holding this very tab', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    mockSessionTable = {tabId: 'tab-1'};
    const tree = await mount();
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-confirm');
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  it('leaves another table’s session alone', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    mockSessionTable = {tabId: 'some-other-tab'};
    const tree = await mount();
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-confirm');
    expect(mockEndSession).not.toHaveBeenCalled();
  });
});

describe('a refusal stops the request', () => {
  it('refuses an unpaid balance, names it, and posts nothing', async () => {
    const {table, lines} = settledAndReady();
    table.tab!.unpaid_total = 45;
    table.tab!.orders[0].payment_status = 'unpaid';
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    const text = renderedText(tree.toJSON());
    expect(text).toContain(CLOSE_REFUSED_TITLE);
    expect(text).toContain(CLOSE_TABLE_REFUSAL_COPY.UNPAID_BALANCE);
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  it('refuses an outstanding kitchen line and posts nothing', async () => {
    const {table, lines} = settledAndReady();
    lines.orders[0].lines[0].is_ready = false;
    lines.all_ready = false;
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    expect(renderedText(tree.toJSON())).toContain(
      CLOSE_TABLE_REFUSAL_COPY.OUTSTANDING_LINE,
    );
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  it('refuses a card payment in flight and posts nothing', async () => {
    const {table, lines} = settledAndReady();
    table.tab!.orders[0].payment_status = 'terminal_pending';
    table.tab!.orders[0].card_payment_in_flight = true;
    table.tab!.orders[0].card_in_flight_seconds = 12;
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    expect(renderedText(tree.toJSON())).toContain(
      CLOSE_TABLE_REFUSAL_COPY.CARD_PAYMENT_IN_FLIGHT,
    );
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  /**
   * "Could not read it" must land as a refusal, not as an error the waiter can dismiss past. The
   * fetch is caught inside the component precisely so this becomes a reason rather than a message.
   */
  it('refuses when the fulfilment view could not be read at all', async () => {
    const {table} = settledAndReady();
    serve(table, null);
    const tree = await mount();
    await press(tree, 'close-table-button');
    expect(renderedText(tree.toJSON())).toContain(
      CLOSE_TABLE_REFUSAL_COPY.LINES_UNKNOWN,
    );
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  it('shows every reason at once, not just the first', async () => {
    const {table, lines} = settledAndReady();
    table.tab!.unpaid_total = 45;
    table.tab!.orders[0].payment_status = 'unpaid';
    lines.orders[0].lines[0].is_ready = false;
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    const text = renderedText(tree.toJSON());
    expect(text).toContain(CLOSE_TABLE_REFUSAL_COPY.UNPAID_BALANCE);
    expect(text).toContain(CLOSE_TABLE_REFUSAL_COPY.ORDER_OWES_MONEY);
    expect(text).toContain(CLOSE_TABLE_REFUSAL_COPY.OUTSTANDING_LINE);
  });

  it('re-reads the table on every press rather than trusting a stale verdict', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    const tree = await mount();
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-cancel');
    await press(tree, 'close-table-button');
    expect(mockGetTablesWithMeta).toHaveBeenCalledTimes(2);
    expect(mockGetTabLines).toHaveBeenCalledTimes(2);
  });
});

describe('the refusal this device cannot predict', () => {
  /**
   * Rounds a customer placed that are still waiting to be accepted or declined block the close
   * server-side, and neither payload carries them. The 409 must reach the shared prompt intact —
   * flattening it into a generic failure is the dead end #120 was about.
   */
  it('hands a 409 PENDING_ORDER_REQUESTS to the stranded-request prompt', async () => {
    const {table, lines} = settledAndReady();
    serve(table, lines);
    mockCloseTable.mockRejectedValue(
      new ApiRequestError('Rounds are waiting for review', 409, {
        code: 'PENDING_ORDER_REQUESTS',
        pendingRequests: [{id: 'req-1', status: 'accepting', value: 120}],
      }),
    );
    const tree = await mount();
    await press(tree, 'close-table-button');
    await press(tree, 'close-table-confirm');
    // Located by the server's own message, a string, because findByProps compares prop values by
    // identity — a fresh array literal never matches the array the component was handed.
    const prompts = tree.root.findAllByProps({
      message: 'Rounds are waiting for review',
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0].props.visible).toBe(true);
    expect(prompts[0].props.requests).toEqual([
      {id: 'req-1', status: 'accepting', value: 120},
    ]);
    expect(tree.root.findAllByProps({testID: 'close-table-failure'}).length).toBe(
      0,
    );
  });
});
