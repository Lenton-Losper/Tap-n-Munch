/**
 * RC SPRINT 2026-09-30 — SENDING A ROUND, END TO END ON THE DEVICE: A2-A5 and M (terminal side).
 *
 * THE REAL review screen, THE REAL ServiceSessionProvider, THE REAL lib/api.ts sendRound. Only the
 * wire (global fetch) and the native token store are faked. roundSendUnknownOutcome.test.tsx covers
 * the same screen with sendRound mocked; this file is the one where the request body, the header and
 * the NUMBER of POSTs are the thing measured, so a double-tap or a rotated key cannot hide behind a
 * mock.
 *
 * THE FAKE SERVER IS app/api/terminal/rounds/route.ts's CONTRACT (web 5d6f2bc4), not an invention:
 *   - no x-idempotency-key                  -> 400 IDEMPOTENCY_KEY_REQUIRED
 *   - key seen, SAME items (tab + items)    -> 200 {duplicate: true, items: <stored>, ...}
 *   - key seen, DIFFERENT items             -> 409 {code: IDEMPOTENCY_KEY_BODY_MISMATCH, items}
 *   - new key                               -> 200 {duplicate: false, ...}
 * isSameRound compares the tab and the ITEMS only (lib/orders/round-idempotency.ts) — the order
 * note is NOT compared, which is why A5 below matters.
 *
 * "Response lost" is modelled as the server APPLYING the request and the socket then failing: fetch
 * rejects with a TypeError after the fake has recorded the round.
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

import ServiceRoundReviewScreen from '../ServiceRoundReviewScreen';
import {
  ServiceSessionProvider,
  useServiceSession,
} from '../../context/ServiceSessionContext';
import * as RoundCopy from '../../constants/roundSendCopy';

// ------------------------------------------------------------------------------------------------
// THE WIRE — a fake of the rounds route's idempotency contract
// ------------------------------------------------------------------------------------------------
type Posted = {key: string | null; body: Record<string, unknown>};
let posts: Posted[] = [];
type Stored = {items: string; order_id: string; order_number: number; itemsView: unknown[]};
let rounds: Map<string, Stored>;
let nextOrderNumber = 160;
/** Per-call behaviour, consumed in order: 'ok' | 'drop' (apply, then lose the response) | 'hold'. */
let script: Array<'ok' | 'drop' | 'hold' | 'fail500'> = [];
const held: Array<() => void> = [];

function res(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => 'application/json'},
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** The comparable shape of a round, as isSameRound compares it: tab + items (never the note). */
function fingerprint(body: Record<string, unknown>): string {
  const items = (body.items as Array<Record<string, unknown>>).map(i => ({
    menuItemId: i.menuItemId,
    quantity: i.quantity,
    note: i.note ?? '',
    selectedVariants: i.selectedVariants ?? null,
  }));
  return JSON.stringify({tab: body.tab_id, items});
}

function serve(key: string | null, body: Record<string, unknown>): Response {
  if (!key) {
    return res(400, {error: 'x-idempotency-key is required', code: 'IDEMPOTENCY_KEY_REQUIRED'});
  }
  const itemsView = (body.items as Array<Record<string, unknown>>).map(i => ({
    name: i.name,
    quantity: i.quantity,
  }));
  const prior = rounds.get(key);
  if (prior) {
    if (prior.items !== fingerprint(body)) {
      return res(409, {
        code: 'IDEMPOTENCY_KEY_BODY_MISMATCH',
        error: 'This send reuses the key of an earlier one that the server already has, but the items differ.',
        order_id: prior.order_id,
        order_number: prior.order_number,
        tab_id: body.tab_id,
        items: prior.itemsView,
      });
    }
    return res(200, {
      success: true,
      duplicate: true,
      order_id: prior.order_id,
      order_number: prior.order_number,
      tab_id: body.tab_id,
      lines_written: true,
      line_count: prior.itemsView.length,
      station_counts: {kitchen: prior.itemsView.length, bar: 0, unrouted: 0},
      items: prior.itemsView,
    });
  }
  const order_number = nextOrderNumber++;
  const stored = {items: fingerprint(body), order_id: `o-${order_number}`, order_number, itemsView};
  rounds.set(key, stored);
  return res(200, {
    success: true,
    duplicate: false,
    order_id: stored.order_id,
    order_number,
    tab_id: body.tab_id,
    lines_written: true,
    line_count: itemsView.length,
    station_counts: {kitchen: itemsView.length, bar: 0, unrouted: 0},
  });
}

function installWire() {
  (globalThis as unknown as {fetch: unknown}).fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/terminal/rounds') {
      return res(404, {error: `rcRoundSendWire: unrouted ${url.pathname}`});
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers['x-idempotency-key'] ?? null;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({key, body});
    const mode = script.shift() ?? 'ok';
    if (mode === 'fail500') {
      return res(500, {error: 'boom'});
    }
    if (mode === 'drop') {
      serve(key, body);
      throw new TypeError('Network request failed');
    }
    if (mode === 'hold') {
      return new Promise<Response>(resolve => {
        held.push(() => resolve(serve(key, body)));
      });
    }
    return serve(key, body);
  };
}

// ------------------------------------------------------------------------------------------------
// THE SCREEN
// ------------------------------------------------------------------------------------------------
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

/** Lets a test unmount and remount the review screen while the provider (the session) survives. */
let setShowReview: ((v: boolean) => void) | null = null;
function Harness() {
  const [show, setShow] = React.useState(true);
  setShowReview = setShow;
  return (
    <ServiceSessionProvider>
      <Capture />
      {show ? (
        <ServiceRoundReviewScreen navigation={NAV as never} route={{} as never} />
      ) : null}
    </ServiceSessionProvider>
  );
}

const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const t of mounted.splice(0)) {
      t.unmount();
    }
  });
});

beforeAll(() => {
  const encrypted = require('react-native-encrypted-storage').default as {getItem: jest.Mock};
  encrypted.getItem.mockImplementation(async (key: string) =>
    key === 'flashtap_terminal_token' ? 'rc-terminal-token' : null,
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  posts = [];
  rounds = new Map();
  script = [];
  held.splice(0);
  nextOrderNumber = 160;
  sessionRef.current = null;
  installWire();
});

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<Harness />);
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
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
const press = async (node: ReactTestInstance) => {
  await act(async () => {
    await node.props.onPress();
  });
  await flush();
};

// ================================================================================================
describe('A4 — a double tap on Send is ONE request', () => {
  it('MUTATION GUARD (A4): two presses in one batch, before a re-render, POST the round once', async () => {
    script = ['hold'];
    const tree = await mount();
    const send = byId(tree, 'round-send');
    await act(async () => {
      // Same handler instance twice: React has not re-rendered `sending` between the two presses.
      void send.props.onPress();
      void send.props.onPress();
      await Promise.resolve();
    });
    await flush();
    expect(posts).toHaveLength(1);

    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(allText(tree)).toContain('Round sent');
    expect(rounds.size).toBe(1);
  });

  it('five rapid presses are one POST; after an unknown outcome the guard is released for Retry', async () => {
    script = ['drop', 'ok'];
    const tree = await mount();
    const send = byId(tree, 'round-send');
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        void send.props.onPress();
      }
      await Promise.resolve();
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(has(tree, 'round-unknown-outcome')).toBe(true);
    // Not stuck: the guard came off with the answer, so Retry reaches the server.
    await press(byId(tree, 'round-send'));
    expect(posts).toHaveLength(2);
    expect(posts[1].key).toBe(posts[0].key);
    expect(rounds.size).toBe(1);
  });
});

describe('A2 — the server took the round but the answer was lost', () => {
  it('locks, Retry re-sends the SAME key and SAME body, and the answer is "Already sent" — one round on the server', async () => {
    script = ['drop', 'ok'];
    const tree = await mount();
    await press(byId(tree, 'round-send'));

    // The server HAS the round; the device does not know that.
    expect(rounds.size).toBe(1);
    expect(has(tree, 'round-unknown-outcome')).toBe(true);
    expect(session().roundLock).not.toBeNull();
    expect(allText(tree)).not.toContain('Round sent');

    await press(byId(tree, 'round-send')); // "Retry the same round"

    expect(posts).toHaveLength(2);
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
    expect(rounds.size).toBe(1);
    expect(byId(tree, 'round-duplicate-title').props.children).toBe(RoundCopy.ROUND_ALREADY_SENT_TITLE);
    expect(allText(tree)).toContain('1× Modena Pasta');
    expect(allText(tree)).not.toContain('Round sent');
  });

  it('a 5xx is unknown too, and the retry replays rather than creating a second round', async () => {
    script = ['fail500', 'ok'];
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    expect(has(tree, 'round-unknown-outcome')).toBe(true);
    await press(byId(tree, 'round-send'));
    expect(posts[1].key).toBe(posts[0].key);
    // Nothing was stored by the 500, so the retry is the first real send: a fresh "Round sent".
    expect(rounds.size).toBe(1);
    expect(allText(tree)).toContain('Round sent');
  });

  it('M: the review screen REMOUNTED while the outcome is unknown keeps the lock and the key', async () => {
    script = ['drop', 'ok'];
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    const key = posts[0].key;

    await act(async () => {
      setShowReview?.(false);
    });
    await act(async () => {
      setShowReview?.(true);
    });
    await flush();

    expect(has(tree, 'round-unknown-outcome')).toBe(true);
    expect(allText(tree)).toContain(RoundCopy.ROUND_RETRY_SAME);
    expect(has(tree, 'round-back')).toBe(false);
    await press(byId(tree, 'round-send'));
    expect(posts).toHaveLength(2);
    expect(posts[1].key).toBe(key);
    expect(rounds.size).toBe(1);
    expect(has(tree, 'round-duplicate-title')).toBe(true);
  });
});

describe('A3 — a key the server already holds with DIFFERENT items', () => {
  it('shows the 409 as "the kitchen has the ORIGINAL round" with the server items, and never "Round sent"', async () => {
    const tree = await mount();
    const key = session().idempotencyKey as string;
    // The server already holds this key for a different basket (an earlier send of this key).
    rounds.set(key, {
      items: 'something else',
      order_id: 'o-159',
      order_number: 159,
      itemsView: [{name: 'Modena Pasta', quantity: 2}],
    });
    await press(byId(tree, 'round-send'));

    expect(posts).toHaveLength(1);
    expect(byId(tree, 'round-key_mismatch-title').props.children).toBe(RoundCopy.ROUND_MISMATCH_TITLE);
    const text = allText(tree);
    expect(text).toContain('2× Modena Pasta');
    expect(text).toContain('Order #159');
    expect(text).not.toContain('Round sent');
    // Definite answer: no lock left, and nothing was re-sent automatically.
    expect(session().roundLock).toBeNull();
    expect(posts).toHaveLength(1);
  });
});

describe('A5 — changing the round while a send is pending', () => {
  it('MUTATION GUARD (A5): the order note cannot be edited while the send is in flight', async () => {
    script = ['hold'];
    const tree = await mount();
    const note = () => tree.root.findByProps({placeholder: 'e.g. allergy: shellfish'});
    expect(note().props.editable).toBe(true);
    await act(async () => {
      void byId(tree, 'round-send').props.onPress();
      await Promise.resolve();
    });
    await flush();
    // The request is out. An allergy note typed now would ride on a RETRY under the same key, and
    // the server — which does not compare notes — would replay the round WITHOUT it.
    expect(note().props.editable).toBe(false);
    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
  });

  it('the basket cannot be changed while the send is in flight (no way back to the round screen)', async () => {
    script = ['hold'];
    const tree = await mount();
    await act(async () => {
      void byId(tree, 'round-send').props.onPress();
      await Promise.resolve();
    });
    await flush();
    expect(byId(tree, 'round-back').props.disabled).toBe(true);
    expect(byId(tree, 'round-back-arrow').props.disabled).toBe(true);
    const preventDefault = jest.fn();
    listeners.beforeRemove({preventDefault});
    expect(preventDefault).toHaveBeenCalled();
    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
  });

  it('after an unknown outcome, item edits AND the note are frozen until a definite answer', async () => {
    script = ['drop'];
    const tree = await mount();
    await press(byId(tree, 'round-send'));
    await act(async () => {
      session().addItem({id: 'm-extra', name: 'Extra', base_price: 10});
      session().setOrderInstructions('allergy: shellfish');
    });
    expect(session().lines.map(l => l.name)).toEqual(['Modena Pasta', 'Riviera Burger']);
    expect(session().orderInstructions).toBe('');
    expect(tree.root.findByProps({placeholder: 'e.g. allergy: shellfish'}).props.editable).toBe(false);
  });
});
