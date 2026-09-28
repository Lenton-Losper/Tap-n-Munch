/**
 * A COOKED LINE ANSWERS WHEN TAPPED, AND THE TAB IS RE-READ AFTER EVERY AMEND OUTCOME.
 * (Sprint 2026-09-28 brief — Riviera #160.)
 *
 * Cooked lines used to be un-pressable, and the only written guidance was "tell them yourself if it
 * has to come off" — an unrecorded verbal cancel. They now open the sheet, which says nothing was
 * removed. And the sheet's refetch callback re-reads the SERVER without closing the sheet: closing
 * was the old success signal, and the list is never patched locally.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import type {TabLine, TabLinesPayload} from '../../lib/tabLines';

const payloadRef: {current: TabLinesPayload | null} = {current: null};
const mockGetTabLines = jest.fn(async () => payloadRef.current);

jest.mock('../../lib/api', () => ({
  __esModule: true,
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(status: number) {
      super('api');
      this.status = status;
    }
  },
  getTabLines: (...a: unknown[]) => (mockGetTabLines as (...x: unknown[]) => unknown)(...a),
  getTablesWithMeta: jest.fn(async () => ({tables: []})),
}));
jest.mock('../../lib/storage', () => ({
  __esModule: true,
  getTerminalToken: jest.fn(async () => 'tok'),
}));
jest.mock('../../lib/realtimeInvalidation', () => ({
  __esModule: true,
  subscribeLineChangeInvalidation: jest.fn(() => () => {}),
  resolveRestaurantId: jest.fn(async () => 'rest-1'),
}));
jest.mock('../../context/ServiceSessionContext', () => ({
  __esModule: true,
  useServiceSession: () => ({table: null, lines: []}),
}));
jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React2 = require('react');
    React2.useEffect(() => cb(), []);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../../components/CloseTableAction', () => ({__esModule: true, default: () => null}));

/** The sheet, replaced by a probe that records what the screen hands it. */
const sheetProps: {current: {line: TabLine | null; onRefetch: () => void; onClose: () => void} | null} =
  {current: null};
jest.mock('../../components/AmendLineSheet', () => ({
  __esModule: true,
  default: (props: {line: TabLine | null; onRefetch: () => void; onClose: () => void}) => {
    sheetProps.current = props;
    return null;
  },
}));

import ServiceTableScreen from '../ServiceTableScreen';

function line(name: string, over: Partial<TabLine>): TabLine {
  return {
    id: `l-${name}`,
    name_snapshot: name,
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    ...over,
  };
}

function payload(lines: TabLine[]): TabLinesPayload {
  return {
    tab: {id: 'tab-1', table_number: 1, status: 'open', total: 240, opened_at: null, opened_by_user_id: null},
    orders: [
      {
        order_id: 'o-160',
        order_number: 160,
        order_instructions: null,
        order_total: 240,
        placed_at: '2026-09-27T19:00:00Z',
        seconds_since_placed: 600,
        lines,
      },
    ],
    summary: {total_lines: lines.length, outstanding: lines.length, ready: 0, voided: 0},
    all_ready: false,
    has_lines: true,
    server_time: null,
  };
}

const ROUTE = {
  params: {
    tableId: 'table-1',
    tableNumber: 1,
    tableName: null,
    tabId: 'tab-1',
    ownerName: 'Sam',
    adoptedExistingTab: false,
    handedOverFrom: null,
  },
} as never;
const NAV = {navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn()} as never;

const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const t of mounted.splice(0)) {
      t.unmount();
    }
  });
});

async function mount(lines: TabLine[]) {
  payloadRef.current = payload(lines);
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ServiceTableScreen route={ROUTE} navigation={NAV} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  mounted.push(tree);
  return tree;
}

const hostRow = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findAll(n => n.props?.testID === `tab-line-${id}` && typeof n.props.onPress === 'function')[0];

describe('every line answers a tap', () => {
  it('a COOKED line is pressable and opens the sheet on that line', async () => {
    const cooked = line('Modena Pasta', {kitchen_state: 'cooked', is_cooked: true});
    const tree = await mount([cooked]);
    const row = hostRow(tree, cooked.id);
    expect(row).toBeDefined();
    expect(row.props.disabled).toBe(false);
    await act(async () => {
      row.props.onPress();
    });
    expect(sheetProps.current?.line?.id).toBe(cooked.id);
  });

  it('a voided line is pressable too (the sheet says it is already cancelled)', async () => {
    const voided = line('Oysters', {is_voided: true});
    const tree = await mount([voided]);
    expect(hostRow(tree, voided.id).props.disabled).toBe(false);
  });
});

describe('the refetch re-reads the server and does not close the sheet', () => {
  it('shows the SERVER\'s lines after the refetch, with the sheet still open', async () => {
    const modena = line('Modena Pasta', {});
    const tree = await mount([modena]);
    await act(async () => {
      hostRow(tree, modena.id).props.onPress();
    });
    const callsBefore = mockGetTabLines.mock.calls.length;

    // The server now says the Modena is voided. The screen must learn that only by reading it.
    payloadRef.current = payload([{...modena, is_voided: true}]);
    await act(async () => {
      sheetProps.current!.onRefetch();
      await Promise.resolve();
    });

    expect(mockGetTabLines.mock.calls.length).toBe(callsBefore + 1);
    expect(sheetProps.current?.line?.id).toBe(modena.id);
    const chip = tree.root.findAll(
      n => typeof n.type === 'string' && n.props?.testID === 'line-chip-voided',
    );
    expect(chip).toHaveLength(1);
  });
});
