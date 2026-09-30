/**
 * RC SPRINT 2026-09-30 — E. PAYMENT NETWORK / APP FAILURE, ON THE DEVICE.
 *
 * Same harness as paymentSimulation.test.tsx: the REAL Charge screen, the REAL payment.ts and the
 * REAL api.ts; only the card reader (NativeModules.PaymentModule), the wire (fetch) and the native
 * stores are faked. The server answers are the web chaos harness's own captured responses
 * (helpers/paysimServerContract.json).
 *
 * WHAT IS NEW HERE IS THE STORAGE AND THE LIFECYCLE. AsyncStorage is backed by a real in-memory map
 * that SURVIVES an unmount, so:
 *   - "leave"   = the navigator's beforeRemove fires, then the screen unmounts (Back, hardware back)
 *   - "crash"   = the screen unmounts with NO beforeRemove (process death); JS promises die with it
 *   - "reopen"  = a fresh mount of the Charge screen for the same order, on the same storage
 *
 * THE INVARIANT EVERY TEST HERE DEFENDS: once a card attempt may have taken money, no path through
 * leaving, reopening, restarting or opening another order puts a live "Process Payment" in front of
 * the waiter for that order until the SERVER has said what happened.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert, NativeModules, Platform} from 'react-native';
import renderer, {act} from 'react-test-renderer';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const React_ = jest.requireActual('react');
    React_.useEffect(cb, [cb]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

import PaymentScreen from '../PaymentScreen';
import {
  UNCONFIRMED_CHECK_ACTION,
  UNCONFIRMED_INTERRUPTED,
  UNCONFIRMED_TITLE,
} from '../../constants/paymentCopy';
import {clearPersistedPaymentState} from '../../components/PaymentStateMachine';

type Reply = {status: number; body: Record<string, unknown>};
const CONTRACT = require('./helpers/paysimServerContract.json') as Record<string, Reply> & {
  _meta: {orderId: string; merchantOrderNo: string; chargeCents: number};
};
const ORDER_ID = CONTRACT._meta.orderId;
const OTHER_ORDER_ID = '0b0b0b0b-1111-4222-8333-444444444444';
const CHARGE_CENTS = CONTRACT._meta.chargeCents;

// ------------------------------------------------------------------------------------------------
// THE WIRE
// ------------------------------------------------------------------------------------------------
type Call = {method: string; path: string; body: Record<string, unknown> | null};
let calls: Call[] = [];
type Scripted = Reply | 'network-error' | 'hang';
let replies: Record<string, Scripted[]> = {};

function routeKey(method: string, path: string): string {
  if (path === '/api/terminal/me') return 'me';
  if (method === 'GET' && path === '/api/terminal/orders') return 'orders';
  if (path.endsWith('/prepare-payment')) return 'prepare';
  if (path.endsWith('/attempt-started')) return 'attemptStarted';
  if (path.endsWith('/verify-payment')) return 'verify';
  if (/\/api\/terminal\/orders\/[^/]+\/payment$/.test(path)) return 'callback';
  if (path === '/api/terminal/payment-events/sale') return 'sale';
  return `unrouted ${method} ${path}`;
}

function jsonResponse(reply: Reply): Response {
  const text = JSON.stringify(reply.body);
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: {get: () => 'application/json'},
    json: async () => JSON.parse(text),
    text: async () => text,
    clone() {
      return this;
    },
  } as unknown as Response;
}

function installWire() {
  (globalThis as unknown as {fetch: unknown}).fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({method, path: url.pathname, body});
    const key = routeKey(method, url.pathname);
    const queue = replies[key];
    if (!queue || queue.length === 0) {
      return jsonResponse({status: 404, body: {error: `rc: no reply for ${key}`}});
    }
    const next = queue.length > 1 ? (queue.shift() as Scripted) : queue[0];
    if (next === 'network-error') {
      throw new TypeError('Network request failed');
    }
    if (next === 'hang') {
      return new Promise<Response>(() => {});
    }
    return jsonResponse(next);
  };
}
const callsTo = (key: string) => calls.filter(c => routeKey(c.method, c.path) === key);

// ------------------------------------------------------------------------------------------------
// THE READER AND THE STORES
// ------------------------------------------------------------------------------------------------
const launchPayment = jest.fn();
function readerApproves(voucherNo = 'RC-TXN-1') {
  launchPayment.mockImplementation(async (_amt: string, _order: string, mo: string) => ({
    voucherNo,
    businessOrderNo: mo,
  }));
}
function readerRejects(code: 'PAYMENT_DECLINED' | 'PAYMENT_AMBIGUOUS', gatewayResult: string) {
  launchPayment.mockImplementation(async () => {
    throw Object.assign(new Error(`gateway result=${gatewayResult}`), {code, userInfo: {gatewayResult}});
  });
}
/** The reader is open and has not answered. `answer` settles it later; never called = process death. */
function readerStaysOpen() {
  const pending: {answer?: (outcome: () => unknown) => void} = {};
  launchPayment.mockImplementation(
    (_amt: string, _order: string, mo: string) =>
      new Promise((resolve, reject) => {
        pending.answer = outcome => {
          const out = outcome() as {voucherNo?: string; reject?: Error};
          if (out.reject) {
            reject(out.reject);
          } else {
            resolve({voucherNo: out.voucherNo, businessOrderNo: mo});
          }
        };
      }),
  );
  return pending;
}

/** AsyncStorage, as the device has it: survives a screen unmount and an app restart. */
const disk = new Map<string, string>();

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

function renderedText(json: unknown): string {
  if (json == null) return '';
  if (typeof json === 'string' || typeof json === 'number') return String(json);
  if (Array.isArray(json)) return json.map(renderedText).join(' ');
  const node = json as {children?: unknown; props?: {children?: unknown}};
  return renderedText(node.children ?? node.props?.children ?? null);
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

type Mounted = {tree: renderer.ReactTestRenderer; beforeRemove: () => void};
async function mount(orderId = ORDER_ID): Promise<Mounted> {
  const listeners: Record<string, (e: {preventDefault: () => void}) => void> = {};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(PaymentScreen, {
        route: {
          params: {
            orderId,
            tableId: 'table-rc',
            tableNumber: 102,
            total: CHARGE_CENTS / 100,
            orderNumber: 7,
            placedAt: '2026-09-29T18:00:00.000Z',
          },
        },
        navigation: {
          navigate: jest.fn(),
          goBack: jest.fn(),
          setOptions: jest.fn(),
          addListener: jest.fn((name: string, cb: (e: {preventDefault: () => void}) => void) => {
            listeners[name] = cb;
            return () => {
              delete listeners[name];
            };
          }),
        },
      } as never),
    );
  });
  await settle();
  return {
    tree,
    beforeRemove: () => listeners.beforeRemove?.({preventDefault: jest.fn()}),
  };
}
/** Back / hardware back: the navigator's beforeRemove, then the screen goes. */
async function leave(m: Mounted) {
  await act(async () => {
    m.beforeRemove();
  });
  await settle();
  await act(async () => {
    m.tree.unmount();
  });
}
/** Process death: no beforeRemove, nothing in JS survives. */
async function crash(m: Mounted) {
  await act(async () => {
    m.tree.unmount();
  });
}

function pressables(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes(label),
  );
}
async function press(tree: renderer.ReactTestRenderer, label: string) {
  const hits = pressables(tree, label);
  if (hits.length === 0) {
    throw new Error(`no pressable "${label}": ${renderedText(tree.toJSON()).slice(0, 500)}`);
  }
  await act(async () => {
    await hits[hits.length - 1].props.onPress();
  });
  await settle();
}
/** True when every "Process Payment" control on screen is disabled (or there is none). */
const processPaymentBlocked = (tree: renderer.ReactTestRenderer) =>
  pressables(tree, 'Process Payment').every(n => n.props.disabled === true);
const screenText = (tree: renderer.ReactTestRenderer) => renderedText(tree.toJSON());

function orderRow(id: string) {
  return {
    id,
    restaurant_id: 'c4a05000-0000-4000-8000-000000000001',
    table_number: 102,
    order_number: 7,
    status: 'pending',
    payment_status: 'pending',
    total: CHARGE_CENTS / 100,
    items: [{name: 'Caesar Salad', quantity: 1, price: 72, total: 72}, {name: 'Chips', quantity: 1, price: 35, total: 35}],
    placed_at: '2026-09-29T18:00:00.000Z',
  };
}

beforeAll(() => {
  Platform.OS = 'android';
  const pm = NativeModules.PaymentModule as Record<string, unknown>;
  pm.launchPayment = launchPayment;
  delete pm.peekOrphanedPaymentResult;
  delete pm.consumeOrphanedPaymentResult;
  const encrypted = require('react-native-encrypted-storage').default as {getItem: jest.Mock};
  encrypted.getItem.mockImplementation(async (key: string) =>
    key === 'flashtap_terminal_token' ? 'rc-terminal-token' : null,
  );
  const async = require('@react-native-async-storage/async-storage').default as Record<string, jest.Mock>;
  async.getItem.mockImplementation(async (k: string) => (disk.has(k) ? (disk.get(k) as string) : null));
  async.setItem.mockImplementation(async (k: string, v: string) => {
    disk.set(k, v);
  });
  async.removeItem.mockImplementation(async (k: string) => {
    disk.delete(k);
  });
});

beforeEach(() => {
  calls = [];
  disk.clear();
  launchPayment.mockReset();
  installWire();
  replies = {
    me: [{status: 200, body: {card_payment_enabled: true, cash_payment_enabled: false}}],
    orders: [{status: 200, body: {orders: [orderRow(ORDER_ID), orderRow(OTHER_ORDER_ID)]}}],
    prepare: [CONTRACT.prepare],
    attemptStarted: [CONTRACT.attemptStarted],
    sale: [CONTRACT.sale],
  };
});

// ================================================================================================
describe('E6 — leaving while the payment is uncertain', () => {
  it('MUTATION GUARD (E6): 9027, Back, reopen -> still "Not confirmed" with Check, and no second charge is possible', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord];
    replies.callback = [CONTRACT.callbackUncertain];
    const first = await mount();
    await press(first.tree, 'Process Payment');
    expect(screenText(first.tree)).toContain(UNCONFIRMED_TITLE);
    await leave(first);

    const again = await mount();
    expect(screenText(again.tree)).toContain(UNCONFIRMED_TITLE);
    expect(pressables(again.tree, UNCONFIRMED_CHECK_ACTION).length).toBeGreaterThan(0);
    expect(processPaymentBlocked(again.tree)).toBe(true);
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('prepare')).toHaveLength(1);
  });

  it('after leaving and reopening, Check recovers the payment the server has — still one launch', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord, CONTRACT.verifyPaid];
    replies.callback = [CONTRACT.callbackUncertain];
    const first = await mount();
    await press(first.tree, 'Process Payment');
    await leave(first);

    const again = await mount();
    await press(again.tree, UNCONFIRMED_CHECK_ACTION);
    expect(screenText(again.tree)).toContain('Payment successful');
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('sale')).toHaveLength(0);
    // Resolved: the record is gone, so the NEXT visit is a normal one.
    await leave(again);
    const third = await mount();
    expect(screenText(third.tree)).not.toContain(UNCONFIRMED_TITLE);
  });

  it('Back WHILE the reader is open, the reader then answers 9027 -> reopen shows "Not confirmed", not a fresh Charge', async () => {
    const reader = readerStaysOpen();
    replies.verify = [CONTRACT.verifyNoRecord];
    replies.callback = [CONTRACT.callbackUncertain];
    const first = await mount();
    await act(async () => {
      void pressables(first.tree, 'Process Payment')[0].props.onPress();
      await Promise.resolve();
    });
    for (let i = 0; i < 20 && !reader.answer; i += 1) {
      await settle();
    }
    await leave(first);
    // The reader answers after the screen has gone.
    await act(async () => {
      reader.answer?.(() => ({
        reject: Object.assign(new Error('gateway result=9027'), {
          code: 'PAYMENT_AMBIGUOUS',
          userInfo: {gatewayResult: '9027'},
        }),
      }));
    });
    await settle();
    await settle();

    const again = await mount();
    expect(screenText(again.tree)).toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(again.tree)).toBe(true);
    expect(launchPayment).toHaveBeenCalledTimes(1);
  });

  it('CONTROL (liveness): Back while the reader is open, the reader then DECLINES -> reopen is a normal Charge', async () => {
    const reader = readerStaysOpen();
    replies.callback = [CONTRACT.callbackDeclined];
    const first = await mount();
    await act(async () => {
      void pressables(first.tree, 'Process Payment')[0].props.onPress();
      await Promise.resolve();
    });
    for (let i = 0; i < 20 && !reader.answer; i += 1) {
      await settle();
    }
    await leave(first);
    await act(async () => {
      reader.answer?.(() => ({
        reject: Object.assign(new Error('Card declined by gateway (gateway result=N003)'), {
          code: 'PAYMENT_DECLINED',
          userInfo: {gatewayResult: 'N003'},
        }),
      }));
    });
    await settle();
    await settle();

    // A confirmed decline is a definite answer: the order is still owed and may be charged again.
    const again = await mount();
    expect(screenText(again.tree)).not.toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(again.tree)).toBe(false);
  });
});

describe('E4 / E5 — the app dies after the reader was launched', () => {
  it('E4: reader open, process dies, app restarts -> "Not confirmed" (interrupted), Check recovers it, nothing relaunched', async () => {
    readerStaysOpen();
    replies.verify = [CONTRACT.verifyPaid];
    const first = await mount();
    await act(async () => {
      void pressables(first.tree, 'Process Payment')[0].props.onPress();
      await Promise.resolve();
    });
    for (let i = 0; i < 20 && launchPayment.mock.calls.length === 0; i += 1) {
      await settle();
    }
    await crash(first);

    const again = await mount();
    const text = screenText(again.tree);
    expect(text).toContain(UNCONFIRMED_TITLE);
    expect(text).toContain(UNCONFIRMED_INTERRUPTED);
    expect(processPaymentBlocked(again.tree)).toBe(true);
    await press(again.tree, UNCONFIRMED_CHECK_ACTION);
    expect(screenText(again.tree)).toContain('Payment successful');
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('prepare')).toHaveLength(1);
    expect(callsTo('callback')).toHaveLength(0);
  });

  it('MUTATION GUARD (E4b): after the restart ANOTHER order is charged first — the first order is still "Not confirmed"', async () => {
    readerStaysOpen();
    const first = await mount();
    await act(async () => {
      void pressables(first.tree, 'Process Payment')[0].props.onPress();
      await Promise.resolve();
    });
    for (let i = 0; i < 20 && launchPayment.mock.calls.length === 0; i += 1) {
      await settle();
    }
    await crash(first);

    // Restart. The waiter opens a different order first, then leaves it.
    const other = await mount(OTHER_ORDER_ID);
    expect(screenText(other.tree)).not.toContain(UNCONFIRMED_TITLE);
    await leave(other);
    // ...and a POS sale starts a new charge, which clears the legacy slot.
    await clearPersistedPaymentState();

    const again = await mount(ORDER_ID);
    expect(screenText(again.tree)).toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(again.tree)).toBe(true);
    expect(launchPayment).toHaveBeenCalledTimes(1);
  });

  it('E5: reader SUCCESS, process dies before the report -> reopen, Check: the server state wins, no second charge', async () => {
    readerApproves();
    replies.callback = ['hang'];
    replies.verify = [CONTRACT.verifyAlreadyPaid];
    const first = await mount();
    await act(async () => {
      void pressables(first.tree, 'Process Payment')[0].props.onPress();
      await Promise.resolve();
    });
    for (let i = 0; i < 30 && callsTo('callback').length === 0; i += 1) {
      await settle();
    }
    expect(callsTo('callback')).toHaveLength(1);
    await crash(first);

    const again = await mount();
    expect(screenText(again.tree)).toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(again.tree)).toBe(true);
    await press(again.tree, UNCONFIRMED_CHECK_ACTION);
    expect(screenText(again.tree)).toContain('Payment successful');
    expect(launchPayment).toHaveBeenCalledTimes(1);
  });
});

describe('E1 — reader SUCCESS, then the network drops before FlashTap hears', () => {
  it('never FAILED, never a live Process Payment; Check recovers the existing payment; one launch', async () => {
    readerApproves();
    // The success report and the recovery verify both die on the network; the failure report's
    // retry lands and the server (which verifies with Finatic before believing a failure) answers
    // "uncertain" — the E04111-not-registered-yet case.
    replies.callback = ['network-error', CONTRACT.callbackUncertain];
    replies.verify = ['network-error', CONTRACT.verifyPaid];
    const first = await mount();
    await press(first.tree, 'Process Payment');
    const text = screenText(first.tree);
    expect(text).not.toContain('FAILED');
    expect(text).toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(first.tree)).toBe(true);

    // MUTATION GUARD (E1-voucher): the failure report that did land carries the reader's voucher,
    // so reconciliation can tie this order to the card transaction.
    const failed = callsTo('callback').filter(c => c.body?.status === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[failed.length - 1].body).toMatchObject({
      reference: 'RC-TXN-1',
      voucherNo: 'RC-TXN-1',
      businessOrderNo: CONTRACT._meta.merchantOrderNo,
    });

    // Even across a leave and reopen.
    await leave(first);
    const again = await mount();
    expect(screenText(again.tree)).toContain(UNCONFIRMED_TITLE);
    await press(again.tree, UNCONFIRMED_CHECK_ACTION);
    expect(screenText(again.tree)).toContain('Payment successful');
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('prepare')).toHaveLength(1);
  });
});

describe('E2 / E3 — unknown result, checked repeatedly', () => {
  it('Check twice while still uncertain launches nothing, prepares nothing, reports no sale', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord];
    replies.callback = [CONTRACT.callbackUncertain];
    const m = await mount();
    await press(m.tree, 'Process Payment');
    const before = {
      launch: launchPayment.mock.calls.length,
      prepare: callsTo('prepare').length,
      callback: callsTo('callback').length,
      sale: callsTo('sale').length,
    };
    await press(m.tree, UNCONFIRMED_CHECK_ACTION);
    await press(m.tree, UNCONFIRMED_CHECK_ACTION);
    expect({
      launch: launchPayment.mock.calls.length,
      prepare: callsTo('prepare').length,
      callback: callsTo('callback').length,
      sale: callsTo('sale').length,
    }).toEqual(before);
    expect(screenText(m.tree)).toContain(UNCONFIRMED_TITLE);
    expect(processPaymentBlocked(m.tree)).toBe(true);
  });
});
