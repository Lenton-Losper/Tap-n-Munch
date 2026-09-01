/**
 * RENDER EVIDENCE for the collected fix, taken from the real ServiceTableScreen.
 *
 * The unit tests next door (lib/__tests__/collectedLinesArePresented.test.ts) pin the RULE. This
 * one mounts the actual screen and reads what a waiter would see, because the rule being right is
 * not the same claim as the screen rendering it — the defect being fixed lived in a ternary in the
 * component, not in the library.
 *
 * It doubles as the phase's render evidence: the test prints the chip against every line, so the
 * before/after is a run output rather than a description.
 *
 * HOW IT WAS SEEN TO FAIL. Reverting LineRow's `display` back to the original
 * `is_voided ? … : is_ready ? … : waiting` ternary makes the first test fail with the collected
 * line carrying "Being made" — which is precisely the production defect. Recorded here rather than
 * asserted, in the convention this repo already uses.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import * as Copy from '../../constants/serviceCopy';
import type {TabLine, TabLinesPayload} from '../../lib/tabLines';

// ── the screen's world ───────────────────────────────────────────────────────

const payloadRef: {current: TabLinesPayload | null} = {current: null};

jest.mock('../../lib/api', () => ({
  __esModule: true,
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(status: number) {
      super('api');
      this.status = status;
    }
  },
  getTabLines: jest.fn(async () => payloadRef.current),
  // The money read is allowed to fail; the screen must still render the food.
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

jest.mock('../../components/CloseTableAction', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../../components/AmendLineSheet', () => ({
  __esModule: true,
  default: () => null,
}));

import ServiceTableScreen from '../ServiceTableScreen';

// ── fixtures shaped like the CURRENT server payload ──────────────────────────

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

/** A round mid-service: one plate run, one on the pass, one still cooking, one cancelled. */
const LINES: TabLine[] = [
  line('Calamari', {is_collected: true, kitchen_state: 'ready'}),
  line('Ribeye', {is_ready: true, kitchen_state: 'ready'}),
  line('Crème brûlée', {}),
  line('Oysters', {is_voided: true}),
];

function payload(lines: TabLine[]): TabLinesPayload {
  const live = lines.filter(l => !l.is_voided);
  return {
    tab: {
      id: 'tab-1',
      table_number: 7,
      status: 'open',
      total: 612.5,
      opened_at: '2026-09-01T11:00:00Z',
      opened_by_user_id: null,
    },
    orders: [
      {
        order_id: 'o1',
        order_number: 41,
        order_instructions: null,
        order_total: 612.5,
        placed_at: '2026-09-01T11:20:00Z',
        seconds_since_placed: 900,
        lines,
      },
    ],
    summary: {
      total_lines: lines.length,
      outstanding: live.filter(l => !l.is_ready && !l.is_collected).length,
      ready: live.filter(l => l.is_ready).length,
      collected: live.filter(l => l.is_collected).length,
      voided: lines.filter(l => l.is_voided).length,
    },
    all_ready: live.every(l => l.is_ready || l.is_collected),
    has_lines: true,
    server_time: '2026-09-01T11:35:00Z',
  };
}

const ROUTE = {
  params: {
    tableId: 'table-1',
    tableNumber: 7,
    tableName: null,
    tabId: 'tab-1',
    ownerName: 'Sam',
    adoptedExistingTab: false,
    handedOverFrom: null,
  },
} as never;
const NAV = {navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn()} as never;

/**
 * Every mount is registered so afterEach can unmount it. The screen installs a 45s reconciliation
 * poll; leaving it running past the test leaks a timer into Jest's teardown, which surfaces as
 * "a worker process has failed to exit gracefully" and, worse, as an "import after the Jest
 * environment has been torn down" error attributed to whatever ran last.
 */
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

/** The chip text rendered against each line, in screen order. */
function chipsByState(tree: renderer.ReactTestRenderer) {
  // HOST elements only. findAll returns the composite wrapper AND the host View for the same
  // node, so an unfiltered search reports every chip twice.
  return tree.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props?.testID === 'string' &&
        n.props.testID.startsWith('line-chip-'),
    )
    .map(n => {
      const text = n
        .findAllByType(Text)
        .flatMap(t => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
        .filter(c => typeof c === 'string')
        .join('');
      return {state: String(n.props.testID).replace('line-chip-', ''), text};
    });
}

describe('ServiceTableScreen renders collected food as already dealt with', () => {
  it('THE DEFECT: a collected line does not carry the "Being made" chip', async () => {
    const tree = await mount(LINES);
    const chips = chipsByState(tree);

    // RENDER EVIDENCE — printed so the phase's outcome is a run, not a claim.
    console.log('\n  line chips, in screen order:');
    for (const c of chips) {
      console.log(`    ${c.state.padEnd(10)} "${c.text}"`);
    }

    const collected = chips.find(c => c.state === 'collected');
    expect(collected).toBeDefined();
    expect(collected!.text).not.toBe(Copy.TABLE_LINE_WAITING_CHIP);
    expect(collected!.text).toBe(Copy.TABLE_LINE_READY_CHIP);
  });

  it('renders one chip per line, and each line its own state', async () => {
    const chips = chipsByState(await mount(LINES));
    expect(chips.map(c => c.state)).toEqual(['collected', 'ready', 'making', 'voided']);
    expect(chips.map(c => c.text)).toEqual([
      Copy.TABLE_LINE_READY_CHIP,
      Copy.TABLE_LINE_READY_CHIP,
      Copy.TABLE_LINE_WAITING_CHIP,
      Copy.TABLE_LINE_VOIDED_CHIP,
    ]);
  });

  /**
   * The collected chip must be visually distinct from the ready chip even though it says the same
   * word — otherwise the fix trades one wrong reading ("still cooking") for another ("still on the
   * pass"). Asserted on the resolved style, not on a class name.
   */
  it('de-emphasises the collected chip rather than colouring it like food on the pass', async () => {
    const tree = await mount(LINES);
    const chipNode = (state: string) =>
      tree.root.findAll(
        n => typeof n.type === 'string' && n.props?.testID === `line-chip-${state}`,
      )[0];

    const flatten = (s: unknown): Record<string, unknown> =>
      Object.assign({}, ...(Array.isArray(s) ? s : [s]).filter(Boolean));

    const ready = flatten(chipNode('ready').props.style);
    const collected = flatten(chipNode('collected').props.style);

    console.log(`\n  ready chip backgroundColor    : ${String(ready.backgroundColor)}`);
    console.log(`  collected chip backgroundColor: ${String(collected.backgroundColor)}`);

    expect(collected.backgroundColor).not.toBe(ready.backgroundColor);
    // and it is an outline, not a third status fill
    expect(collected.borderWidth).toBe(1);
  });

  it('a payload with no is_collected at all renders exactly as before', async () => {
    const legacy = LINES.map(l => {
      const copy = {...l};
      delete (copy as {is_collected?: boolean}).is_collected;
      return copy;
    });
    const chips = chipsByState(await mount(legacy));
    // The formerly-collected line has no marker of any kind now, so it reads as still being made —
    // which is what an older server genuinely means by that payload.
    expect(chips.map(c => c.state)).toEqual(['making', 'ready', 'making', 'voided']);
  });
});
