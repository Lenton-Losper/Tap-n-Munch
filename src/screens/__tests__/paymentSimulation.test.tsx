/**
 * PAYMENT SIMULATION, DEVICE SIDE -- the real Charge screen, the real payment.ts, the real api.ts.
 *
 * ================================================================================================
 * ONLY TWO THINGS ARE FAKED: THE CARD READER AND THE WIRE
 * ================================================================================================
 *
 *   PaymentScreen.handleProcessPayment / handleCheckPaymentStatus   (real)
 *     -> lib/payment.ts processPaymentIntent / resolveAmbiguousPaymentWithFinatic   (real)
 *       -> lib/api.ts prepareTerminalPayment / completePayment / verifyTerminalPayment ...   (real)
 *         -> fetch                                   <- answered from the SERVER'S OWN RESPONSES
 *       -> NativeModules.PaymentModule.launchPayment <- resolves / rejects as MainActivity does
 *
 * THE SERVER ANSWERS ARE NOT INVENTED. helpers/paysimServerContract.json holds the exact status and
 * JSON body each route returned in the web leg of this simulation
 * (flashtap web, __tests__/chaos/payment-simulation.chaos.ts, run through supabase/tests/chaos-e2e.mjs
 * against real route handlers, real PostgREST and a real Postgres, Finatic simulated at the wire).
 *
 * THE READER'S ANSWERS ARE MainActivity.kt's (android/.../MainActivity.kt, the SALE branch):
 *   "00" + voucher      -> resolve {voucherNo, businessOrderNo}
 *   KNOWN_DECLINE_CODES -> reject PAYMENT_DECLINED "Card declined by gateway (gateway result=N003)"
 *   anything else       -> reject PAYMENT_AMBIGUOUS "Payment result was not a confirmed success
 *                          (gateway result=<code>)", userInfo.gatewayResult = <code>
 *
 * 9027. The code the P5 showed on the owner's last device test. It is in NO source this project
 * holds: not in WiseCashierCodes.kt, not in docs/wisecashier-result-codes.md (the 22-code
 * Transaction table recovered from WiseCashier 2.1.6.42 -- K-family only), not in the Wise SDK
 * javadocs (D:\RN\_wise_sdk_docs) or the decompiled SDK (D:\RN\_wise_sdk_decompile). UNDOCUMENTED.
 * What IS certain is how this build treats it: not "00", not K026, not N003, so MainActivity
 * rejects it PAYMENT_AMBIGUOUS, and the screen must verify rather than assume either outcome.
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
  UNCONFIRMED_NEVER_STARTED,
  UNCONFIRMED_TITLE,
} from '../../constants/paymentCopy';

type Reply = {status: number; body: Record<string, unknown>};
const CONTRACT = require('./helpers/paysimServerContract.json') as Record<string, Reply> & {
  _meta: {orderId: string; merchantOrderNo: string; chargeCents: number};
};

const ORDER_ID = CONTRACT._meta.orderId;
const MO = CONTRACT._meta.merchantOrderNo;
const CHARGE_CENTS = CONTRACT._meta.chargeCents;

// ------------------------------------------------------------------------------------------------
// THE WIRE
// ------------------------------------------------------------------------------------------------
type Call = {method: string; path: string; body: Record<string, unknown> | null};
let calls: Call[] = [];
/** Per-route queues of replies; the last one repeats. */
let replies: Record<string, Reply[]> = {};

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
      return jsonResponse({status: 404, body: {error: `paysim: no reply for ${key}`}});
    }
    return jsonResponse(queue.length > 1 ? (queue.shift() as Reply) : queue[0]);
  };
}
const callsTo = (key: string) => calls.filter(c => routeKey(c.method, c.path) === key);

// ------------------------------------------------------------------------------------------------
// THE READER (NativeModules.PaymentModule, as MainActivity resolves / rejects the SALE intent)
// ------------------------------------------------------------------------------------------------
const launchPayment = jest.fn();
function readerApproves(voucherNo = 'PAYSIM-TXN-1') {
  launchPayment.mockImplementation(async (_amt: string, _order: string, mo: string) => ({
    voucherNo,
    businessOrderNo: mo,
  }));
}
function readerRejects(code: 'PAYMENT_DECLINED' | 'PAYMENT_AMBIGUOUS', gatewayResult: string) {
  const message =
    code === 'PAYMENT_DECLINED'
      ? `Card declined by gateway (gateway result=${gatewayResult})`
      : `Payment result was not a confirmed success (gateway result=${gatewayResult})`;
  launchPayment.mockImplementation(async () => {
    throw Object.assign(new Error(message), {code, userInfo: {gatewayResult}});
  });
}

// ------------------------------------------------------------------------------------------------
// THE SCREEN
// ------------------------------------------------------------------------------------------------
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

function renderedText(json: unknown): string {
  if (json == null) return '';
  if (typeof json === 'string' || typeof json === 'number') return String(json);
  if (Array.isArray(json)) return json.map(renderedText).join(' ');
  const node = json as {children?: unknown; props?: {children?: unknown}};
  return renderedText(node.children ?? node.props?.children ?? null);
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(PaymentScreen, {
        route: {
          params: {
            orderId: ORDER_ID,
            tableId: 'table-paysim',
            tableNumber: 102,
            total: CHARGE_CENTS / 100,
            orderNumber: 7,
            placedAt: '2026-09-29T18:00:00.000Z',
          },
        },
        navigation: {navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), addListener: jest.fn(() => jest.fn())},
      } as never),
    );
  });
  await settle();
  return tree;
}

function pressable(tree: renderer.ReactTestRenderer, label: string) {
  const hits = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes(label),
  );
  if (hits.length === 0) {
    throw new Error(`no pressable "${label}" on screen: ${renderedText(tree.toJSON()).slice(0, 600)}`);
  }
  return hits[hits.length - 1];
}
async function press(tree: renderer.ReactTestRenderer, label: string) {
  const b = pressable(tree, label);
  await act(async () => {
    await b.props.onPress();
  });
  await settle();
}
const screenText = (tree: renderer.ReactTestRenderer) => renderedText(tree.toJSON());
const hasPressable = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes(label),
  ).length > 0;

beforeAll(() => {
  Platform.OS = 'android';
  // payment.ts captured this object at import; the method is swapped per test, not the object.
  const pm = NativeModules.PaymentModule as Record<string, unknown>;
  pm.launchPayment = launchPayment;
  delete pm.peekOrphanedPaymentResult;
  delete pm.consumeOrphanedPaymentResult;
  const encrypted = require('react-native-encrypted-storage').default as {getItem: jest.Mock};
  encrypted.getItem.mockImplementation(async (key: string) =>
    key === 'flashtap_terminal_token' ? 'paysim-terminal-token' : null,
  );
});

beforeEach(() => {
  calls = [];
  launchPayment.mockReset();
  installWire();
  replies = {
    me: [{status: 200, body: {card_payment_enabled: true, cash_payment_enabled: false}}],
    // A tab-less order row, so the amount due is the order's own figure (the one prepare charges).
    orders: [
      {
        status: 200,
        body: {
          orders: [
            {
              id: ORDER_ID,
              restaurant_id: 'c4a05000-0000-4000-8000-000000000001',
              table_number: 102,
              order_number: 7,
              status: 'pending',
              payment_status: 'pending',
              total: CHARGE_CENTS / 100,
              items: [{name: 'Caesar Salad', quantity: 1, price: 72, total: 72}, {name: 'Chips', quantity: 1, price: 35, total: 35}],
              placed_at: '2026-09-29T18:00:00.000Z',
            },
          ],
        },
      },
    ],
    prepare: [CONTRACT.prepare],
    attemptStarted: [CONTRACT.attemptStarted],
    sale: [CONTRACT.sale],
  };
});

/** The prepared charge reached the reader exactly once, for the server's figure and reference. */
function expectOneLaunchForServerFigure() {
  expect(launchPayment).toHaveBeenCalledTimes(1);
  const [amount, , merchantOrderNo] = launchPayment.mock.calls[0] as [string, string, string];
  expect({amount, merchantOrderNo}).toEqual({amount: String(CHARGE_CENTS), merchantOrderNo: MO});
  expect(callsTo('prepare')).toHaveLength(1);
}

// ================================================================================================
describe('payment simulation on the Charge screen (reader and wire faked, everything else real)', () => {
  it('S1 success: one launch for the server figure, success reported once, sale recorded, success shown', async () => {
    readerApproves();
    replies.callback = [CONTRACT.callbackSuccess];
    const tree = await mount();
    await press(tree, 'Process Payment');

    expectOneLaunchForServerFigure();
    const cb = callsTo('callback');
    expect(cb).toHaveLength(1);
    expect(cb[0].body).toMatchObject({status: 'success', reference: 'PAYSIM-TXN-1', businessOrderNo: MO, amount: CHARGE_CENTS / 100});
    expect(callsTo('sale')).toHaveLength(1);
    expect(callsTo('sale')[0].body).toMatchObject({business_order_no: MO, transaction_id: 'PAYSIM-TXN-1', amount: CHARGE_CENTS / 100});
    expect(callsTo('verify')).toHaveLength(0);
    expect(screenText(tree)).toContain('Payment successful');
  });

  it('S2 decline (N003): FAILED, not "Not confirmed"; no verify, reported once as DECLINED-N003, never charged again', async () => {
    readerRejects('PAYMENT_DECLINED', 'N003');
    replies.callback = [CONTRACT.callbackDeclined];
    const tree = await mount();
    await press(tree, 'Process Payment');

    expectOneLaunchForServerFigure();
    const text = screenText(tree);
    expect(text).toContain('FAILED');
    expect(text).not.toContain(UNCONFIRMED_TITLE);
    expect(text).toContain('N003');
    expect(callsTo('verify')).toHaveLength(0); // a confirmed decline is not re-verified on the device
    const cb = callsTo('callback');
    expect(cb).toHaveLength(1);
    // MainActivity's decline rejection carries no businessOrderNo; the server uses the reference it
    // stored at prepare, which is the one it asks Finatic about.
    expect(cb[0].body).toMatchObject({status: 'failed', gatewayResult: 'N003', paymentMethod: 'card'});
    expect(String(cb[0].body?.reference)).toMatch(/^DECLINED-N003-/);
    // Not a user cancel: the server must verify with Finatic before acting on it.
    expect(cb[0].body).not.toHaveProperty('noGatewayAttempt');
    expect(cb[0].body).not.toHaveProperty('cancellationReason');
    expect(callsTo('sale')).toHaveLength(0);
  });

  it('S3 9027: "Not confirmed" with Check offered; one launch; the failure goes to verify first, then is reported UNCONFIRMED', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord];
    replies.callback = [CONTRACT.callbackUncertain];
    const tree = await mount();
    await press(tree, 'Process Payment');

    expectOneLaunchForServerFigure();
    const text = screenText(tree);
    expect(text).toContain(UNCONFIRMED_TITLE);
    expect(text).not.toContain('FAILED');
    expect(hasPressable(tree, UNCONFIRMED_CHECK_ACTION)).toBe(true);
    // resolveAmbiguousPaymentWithFinatic asked the server once, then the outcome was reported.
    expect(callsTo('verify')).toHaveLength(1);
    const cb = callsTo('callback');
    expect(cb).toHaveLength(1);
    expect(cb[0].body).toMatchObject({status: 'failed', gatewayResult: '9027', businessOrderNo: MO});
    expect(String(cb[0].body?.reference)).toMatch(/^UNCONFIRMED-/);
    expect(cb[0].body).not.toHaveProperty('noGatewayAttempt');
    // No automatic second charge and no second prepare.
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('prepare')).toHaveLength(1);
    expect(callsTo('sale')).toHaveLength(0);
  });

  it('S3/S4 "Check payment status" calls verify-payment only (never prepare, never the reader); paid -> success, still one launch', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord, CONTRACT.verifyPaid];
    replies.callback = [CONTRACT.callbackUncertain];
    const tree = await mount();
    await press(tree, 'Process Payment');
    expect(screenText(tree)).toContain(UNCONFIRMED_TITLE);
    const before = {verify: callsTo('verify').length, prepare: callsTo('prepare').length, callback: callsTo('callback').length};

    await press(tree, UNCONFIRMED_CHECK_ACTION);

    const verifyCalls = callsTo('verify');
    expect(verifyCalls).toHaveLength(before.verify + 1);
    expect(verifyCalls[verifyCalls.length - 1].path).toBe(`/api/terminal/orders/${ORDER_ID}/verify-payment`);
    expect(callsTo('prepare')).toHaveLength(before.prepare);
    expect(callsTo('callback')).toHaveLength(before.callback); // the server already settled it
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(screenText(tree)).toContain('Payment successful');
  });

  it('S5 duplicate success: the server already settled it (webhook first, 409 ALREADY_PAID) -> success once, no failure report, no second launch', async () => {
    readerApproves();
    replies.callback = [CONTRACT.callbackAlreadyPaid];
    const tree = await mount();
    await press(tree, 'Process Payment');

    expectOneLaunchForServerFigure();
    expect(callsTo('callback')).toHaveLength(1);
    expect(callsTo('callback')[0].body).toMatchObject({status: 'success'});
    expect(callsTo('callback').some(c => c.body?.status === 'failed')).toBe(false);
    expect(callsTo('verify')).toHaveLength(0);
    expect(screenText(tree)).toContain('Payment successful');
    expect(screenText(tree)).not.toContain('FAILED');
  });

  /**
   * DEFECT, REPORTED NOT FIXED (paysim, 2026-09-29). Two presses dispatched in the same batch both
   * reach PaymentModule.launchPayment. handleProcessPayment has no synchronous re-entrancy guard --
   * the button's `disabled` comes from React state, which has not re-rendered between the two
   * presses. TableDetailScreen.runSettle closed exactly this hole with a ref (`settleInFlight`);
   * PaymentScreen did not. Native does not refuse either: PaymentModule.launchPayment overwrites
   * `pendingPromise` and starts a second WiseCashier SALE for the same merchant order number, and
   * the first promise is never settled (it ends in the #346 timeout -> 'ambiguous' path).
   * Asserts the correct behaviour; `it.failing` until the guard exists.
   */
  it.failing('S5-D3 DEFECT: a same-batch double tap on Process Payment reaches the reader once', async () => {
    const finishers: Array<() => void> = [];
    launchPayment.mockImplementation(
      (_a: string, _o: string, mo: string) =>
        new Promise(resolve => {
          finishers.push(() => resolve({voucherNo: 'PAYSIM-TXN-1', businessOrderNo: mo}));
        }),
    );
    replies.callback = [CONTRACT.callbackSuccess];
    const tree = await mount();
    const button = pressable(tree, 'Process Payment');
    // Two presses dispatched in the same batch, before React can re-render the button disabled.
    let presses!: Promise<unknown>;
    await act(async () => {
      presses = Promise.all([button.props.onPress(), button.props.onPress()]);
      await Promise.resolve();
    });
    for (let i = 0; i < 50 && finishers.length === 0; i += 1) {
      await settle();
    }
    await settle();
    await act(async () => {
      finishers.forEach(f => f());
      await presses;
    });
    await settle();
    expect(launchPayment).toHaveBeenCalledTimes(1);
    expect(callsTo('prepare')).toHaveLength(1);
    expect(callsTo('callback')).toHaveLength(1);
  });

  /**
   * RULING CONFLICT, ESCALATED -- NOT FIXED HERE (paysim, 2026-09-29).
   *
   * #354's signed copy says E04111 means "the card machine was stopped before it reached the payment
   * provider, so nothing was charged", and removes the Check button. That premise holds for K026 (an
   * operator cancel, raised before authorisation). It does NOT hold after an UNKNOWN reader result:
   * the server's own E04111 ruling (lib/payments/query-finatic-order-paid.ts) is that a single E04111
   * "means not registered at the gateway YET" -- order #149 flipped to paid 22 seconds later.
   *
   * After a 9027 the P5 never said the reader stopped. One E04111 on Check then tells the waiter
   * "nothing was charged ... Take payment again" and takes the Check button away -- the exact move
   * that produces a second charge if the first one lands. This test asserts the SAFE behaviour and is
   * `it.failing` while the screen does otherwise; it turns red when the conflict is resolved.
   */
  it.failing('S3-D2 RULING CONFLICT: after a 9027, one E04111 on Check must not say "nothing was charged" or remove Check', async () => {
    readerRejects('PAYMENT_AMBIGUOUS', '9027');
    replies.verify = [CONTRACT.verifyNoRecord];
    replies.callback = [CONTRACT.callbackUncertain];
    const tree = await mount();
    await press(tree, 'Process Payment');
    await press(tree, UNCONFIRMED_CHECK_ACTION);
    const text = screenText(tree);
    // Evidence, printed whichever way it goes.
    console.log(`[paysim] S3-D2 screen after Check: ${text.slice(0, 400)}`);
    expect(text).not.toContain(UNCONFIRMED_NEVER_STARTED);
    expect(hasPressable(tree, UNCONFIRMED_CHECK_ACTION)).toBe(true);
  });
});
