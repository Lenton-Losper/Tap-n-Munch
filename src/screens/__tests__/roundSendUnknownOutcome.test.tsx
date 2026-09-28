/**
 * A ROUND WHOSE OUTCOME IS UNKNOWN LOCKS THE BASKET. (Sprint 2026-09-28 brief — Riviera #160.)
 *
 * THE INCIDENT. A Send timed out. The waiter took Modena Pasta out of the basket and pressed Send
 * again with the SAME idempotency key. The server replayed the ORIGINAL round — Modena included —
 * and the terminal showed a green "Round sent" over the edited basket. The kitchen cooked it.
 *
 * Mounted against the REAL ServiceSessionProvider (so the lock is the real one) and the real review
 * screen, with sendRound and getTabLines mocked.
 *
 * MUTATION GUARD (c): "the basket stays editable after an unknown outcome"
 *   -> 'the basket cannot be edited, and the key cannot rotate, while the outcome is unknown'
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

const mockSendRound = jest.fn();
const mockGetTabLines = jest.fn();
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    sendRound: (...a: unknown[]) => mockSendRound(...a),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...a),
  };
});
jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'jwt')};
});

import ServiceRoundReviewScreen from '../ServiceRoundReviewScreen';
import {
  ServiceSessionProvider,
  useServiceSession,
} from '../../context/ServiceSessionContext';
import * as RoundCopy from '../../constants/roundSendCopy';
import type {TabLinesPayload} from '../../lib/tabLines';

const {
  RoundOutcomeUnknownError,
  RoundKeyMismatchError,
  RoundPricingRefusedError,
} = jest.requireActual('../../lib/api');

type Session = ReturnType<typeof useServiceSession>;
const sessionRef: {current: Session | null} = {current: null};
function Capture() {
  sessionRef.current = useServiceSession();
  return null;
}
const session = () => sessionRef.current as Session;

const listeners: Record<string, (e: {preventDefault: () => void}) => void> = {};
const NAV = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
  replace: jest.fn(),
  addListener: jest.fn((name: string, cb: (e: {preventDefault: () => void}) => void) => {
    listeners[name] = cb;
    return () => {
      delete listeners[name];
    };
  }),
};

const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const t of mounted.splice(0)) {
      t.unmount();
    }
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionRef.current = null;
});

/** Mount with Table 1 open and a basket of Modena Pasta + Burger. */
async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ServiceSessionProvider>
        <Capture />
        <ServiceRoundReviewScreen navigation={NAV as never} route={{} as never} />
      </ServiceSessionProvider>,
    );
  });
  mounted.push(tree);
  await act(async () => {
    session().beginSession(
      {userId: 'w1', name: 'Sam'},
      {tableId: 't1', tableNumber: 1, tableName: null, tabId: 'tab-1', ownerName: 'Sam'},
    );
  });
  await act(async () => {
    session().addItem({id: 'm-modena', name: 'Modena Pasta', base_price: 240});
    session().addItem({id: 'm-burger', name: 'Riviera Burger', base_price: 155});
  });
  return tree;
}

const byId = (tree: renderer.ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.findByProps({testID: id});
const has = (tree: renderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({testID: id}).length > 0;
const allText = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(t => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    })
    .join(' | ');
const press = async (node: ReactTestInstance) => {
  await act(async () => {
    await node.props.onPress();
  });
};

const OK = (over: Record<string, unknown> = {}) => ({
  success: true,
  duplicate: false,
  order_id: 'o-160',
  order_number: 160,
  tab_id: 'tab-1',
  lines_written: true,
  line_count: 2,
  station_counts: {kitchen: 2, bar: 0, unrouted: 0},
  persisted_items: [],
  ...over,
});

describe.each([
  ['a timeout', () => new RoundOutcomeUnknownError('No answer in time.', 'timeout', null)],
  ['a network error', () => new RoundOutcomeUnknownError('No connection.', 'network', null)],
  ['a 500', () => new RoundOutcomeUnknownError('boom', 'server', 500)],
])('after %s', (_label, make) => {
  it('MUTATION GUARD (c): the basket cannot be edited, and the key cannot rotate, while the outcome is unknown', async () => {
    mockSendRound.mockRejectedValueOnce(make());
    const tree = await mount();
    const keyBefore = session().idempotencyKey;
    const modena = session().lines.find(l => l.name === 'Modena Pasta')!;

    await press(byId(tree, 'round-send'));

    expect(session().roundLock).not.toBeNull();
    expect(has(tree, 'round-unknown-outcome')).toBe(true);

    // Every edit the round screen can make, attempted. None may land.
    await act(async () => {
      session().removeItem(modena.lineId);
      session().adjustQuantity(modena.lineId, 1);
      session().updateLine(modena.lineId, {quantity: 0, note: ''});
      session().setNote(modena.lineId, 'no cheese');
      session().addItem({id: 'm-extra', name: 'Extra', base_price: 10});
      session().setOrderInstructions('changed');
      session().clearBasket();
    });
    expect(session().lines.map(l => [l.name, l.quantity, l.note])).toEqual([
      ['Modena Pasta', 1, ''],
      ['Riviera Burger', 1, ''],
    ]);
    expect(session().orderInstructions).toBe('');
    expect(session().idempotencyKey).toBe(keyBefore);
  });

  it('offers ONLY Retry the same round and Check the table — no Back, no leaving', async () => {
    mockSendRound.mockRejectedValueOnce(make());
    const tree = await mount();
    await press(byId(tree, 'round-send'));

    expect(allText(tree)).toContain(RoundCopy.ROUND_RETRY_SAME);
    expect(has(tree, 'round-check-table')).toBe(true);
    expect(has(tree, 'round-back')).toBe(false);
    expect(byId(tree, 'round-back-arrow').props.disabled).toBe(true);

    // The hardware back / swipe is refused too.
    const preventDefault = jest.fn();
    listeners.beforeRemove({preventDefault});
    expect(preventDefault).toHaveBeenCalled();
  });

  it('Retry re-sends the SAME items under the SAME key, and a duplicate reads "Already sent"', async () => {
    mockSendRound.mockRejectedValueOnce(make());
    mockSendRound.mockResolvedValueOnce(
      OK({
        duplicate: true,
        persisted_items: [
          {name: 'Modena Pasta', quantity: 1},
          {name: 'Riviera Burger', quantity: 1},
        ],
      }),
    );
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    await press(byId(tree, 'round-send'));

    expect(mockSendRound).toHaveBeenCalledTimes(2);
    const [first, second] = mockSendRound.mock.calls.map(c => c[0]);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.items).toEqual(first.items);

    expect(byId(tree, 'round-duplicate-title').props.children).toBe(
      'Already sent — this is what the kitchen has',
    );
    expect(allText(tree)).toContain('1× Modena Pasta');
    expect(allText(tree)).not.toContain('Round sent');
  });
});

describe('a fresh 2xx', () => {
  it('CONTROL: an unlocked basket is editable, and a first send reads Round sent', async () => {
    mockSendRound.mockResolvedValueOnce(OK());
    const tree = await mount();
    const modena = session().lines.find(l => l.name === 'Modena Pasta')!;
    await act(async () => {
      session().adjustQuantity(modena.lineId, 1);
    });
    expect(session().lines.find(l => l.name === 'Modena Pasta')!.quantity).toBe(2);
    await press(byId(tree, 'round-send'));
    expect(allText(tree)).toContain('Round sent');
  });
});

describe('duplicate from an OLDER server (no items) reads the items off the table', () => {
  it('shows the server order\'s lines, never the basket', async () => {
    mockSendRound.mockResolvedValueOnce(OK({duplicate: true, persisted_items: []}));
    mockGetTabLines.mockResolvedValueOnce({
      orders: [
        {
          order_id: 'o-160',
          order_number: 160,
          lines: [
            {name_snapshot: 'Modena Pasta', quantity: 1, is_voided: false},
            {name_snapshot: 'Old Voided', quantity: 1, is_voided: true},
          ],
        },
      ],
    } as unknown as TabLinesPayload);
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    expect(has(tree, 'round-duplicate-title')).toBe(true);
    expect(allText(tree)).toContain('1× Modena Pasta');
    expect(allText(tree)).not.toContain('Old Voided');
    expect(allText(tree)).not.toContain('Riviera Burger');
  });
});

describe('409 IDEMPOTENCY_KEY_BODY_MISMATCH', () => {
  it('says the kitchen has the ORIGINAL round, lists it, and says removal needs a void', async () => {
    mockSendRound.mockRejectedValueOnce(
      new RoundKeyMismatchError('different', 'o-160', 160, [
        {name: 'Modena Pasta', quantity: 1},
        {name: 'Riviera Burger', quantity: 1},
      ]),
    );
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    expect(byId(tree, 'round-key_mismatch-title').props.children).toBe(
      RoundCopy.ROUND_MISMATCH_TITLE,
    );
    const text = allText(tree);
    expect(text).toContain('1× Modena Pasta');
    expect(text).toMatch(/manager void/);
    expect(text).toContain('Order #160');
    expect(session().roundLock).toBeNull();
  });
});

describe('C5 400 pricing refusal', () => {
  it('shows the refusal and the items, offers no resend, and never retries', async () => {
    mockSendRound.mockRejectedValueOnce(
      new RoundPricingRefusedError('Pick a size', 'MENU_ITEM_VARIANT_REQUIRED', ['Modena Pasta']),
    );
    const tree = await mount();
    await press(byId(tree, 'round-send'));

    expect(has(tree, 'round-pricing-refused')).toBe(true);
    expect(allText(tree)).toContain('Pick a size');
    expect(allText(tree)).toContain('• Modena Pasta');
    expect(has(tree, 'round-send')).toBe(false);
    expect(has(tree, 'round-pricing-fix')).toBe(true);
    expect(mockSendRound).toHaveBeenCalledTimes(1);
    // Definite: nothing was created, so the basket is editable again.
    expect(session().roundLock).toBeNull();
  });
});

describe('Check the table', () => {
  function tabWith(orders: unknown[]): TabLinesPayload {
    return {orders} as unknown as TabLinesPayload;
  }

  it('finds an order placed since Send carrying the round, and still offers only Retry', async () => {
    mockSendRound.mockRejectedValueOnce(new RoundOutcomeUnknownError('t', 'timeout', null));
    mockGetTabLines.mockResolvedValueOnce(
      tabWith([
        {
          order_id: 'old',
          order_number: 150,
          seconds_since_placed: 3600,
          lines: [{name_snapshot: 'Modena Pasta', quantity: 1, is_voided: false}],
        },
        {
          order_id: 'o-160',
          order_number: 160,
          seconds_since_placed: 5,
          lines: [
            {name_snapshot: 'Modena Pasta', quantity: 1, is_voided: false},
            {name_snapshot: 'Riviera Burger', quantity: 1, is_voided: false},
          ],
        },
      ]),
    );
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    await press(byId(tree, 'round-check-table'));

    expect(has(tree, 'round-check-found')).toBe(true);
    expect(allText(tree)).toContain('Order #160 was placed since you pressed Send');
    // A hint, not a resolution: still locked, still Retry.
    expect(session().roundLock).not.toBeNull();
    expect(allText(tree)).toContain(RoundCopy.ROUND_RETRY_SAME);
  });

  it('says when nothing new is on the table', async () => {
    mockSendRound.mockRejectedValueOnce(new RoundOutcomeUnknownError('t', 'timeout', null));
    mockGetTabLines.mockResolvedValueOnce(tabWith([]));
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    await press(byId(tree, 'round-check-table'));
    expect(has(tree, 'round-check-not-found')).toBe(true);
    expect(session().roundLock).not.toBeNull();
  });

  it('says when the table could not be read', async () => {
    mockSendRound.mockRejectedValueOnce(new RoundOutcomeUnknownError('t', 'network', null));
    mockGetTabLines.mockRejectedValueOnce(new Error('offline'));
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    await press(byId(tree, 'round-check-table'));
    expect(has(tree, 'round-check-failed')).toBe(true);
  });
});
