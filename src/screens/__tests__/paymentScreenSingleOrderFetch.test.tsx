/**
 * THE PAYMENT SCREEN ASKS FOR ITS ONE ORDER, NOT THE RESTAURANT'S WHOLE LIST (2026-09-30).
 *
 * Unlike the other PaymentScreen suites, getOrder is NOT mocked here: the real api.ts runs against a
 * stubbed fetch, so these assert what the screen actually puts on the wire when it opens. The
 * defect was invisible one level up -- the old getOrder returned the right order after downloading
 * every live order for the venue, so a mocked getOrder could never have shown it.
 */
jest.setTimeout(30000);

import React from 'react';
import renderer, {act} from 'react-test-renderer';

const mockGetTerminalInfo = jest.fn();
const mockGetTabLines = jest.fn();
const mockProcessPaymentIntent = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    // getOrder and getOrders are the REAL implementations.
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...(a as [])),
    getHeldOrphanPayments: jest.fn(async () => []),
    getStrandedOrderRequests: jest.fn(async () => []),
    completePayment: jest.fn(async () => ({success: true, canClose: false})),
    completePaymentReliably: jest.fn(async () => true),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    closeTable: jest.fn(async () => ({})),
  };
});

jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...a: unknown[]) => mockProcessPaymentIntent(...(a as [])),
  resolveAmbiguousPaymentWithFinatic: jest.fn(async (_i: string, r: unknown) => r),
  declinedFailureReference: () => 'DECLINED-REF',
  unconfirmedFailureReference: () => 'UNCONFIRMED-REF',
  readHeldOrphanPayments: jest.fn(async () => []),
  acknowledgeHeldOrphanPayment: jest.fn(async () => undefined),
}));

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

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
import {line, payloadWith} from '../../lib/__tests__/helpers/linesPayload';
import {LIVE_TOTAL_UNAVAILABLE} from '../../constants/liveTotalCopy';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function renderedText(json: unknown): string {
  if (json == null) return '';
  if (typeof json === 'string' || typeof json === 'number') return String(json);
  if (Array.isArray(json)) return json.map(renderedText).join(' ');
  const node = json as {children?: unknown; props?: {children?: unknown}};
  return renderedText(node.children ?? node.props?.children ?? null);
}

/** Every fetch the screen made, answered by path. */
let fetched: string[] = [];
let ordersAnswer: {status: number; body: unknown};

function installFetch() {
  fetched = [];
  (globalThis as {fetch?: unknown}).fetch = jest.fn(async (url: string) => {
    fetched.push(url);
    const answer = /\/api\/terminal\/orders(\?|$)/.test(url)
      ? ordersAnswer
      : {status: 404, body: {error: `unstubbed ${url}`}};
    const text = JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: {get: () => null},
      json: async () => JSON.parse(text),
      text: async () => text,
      clone: () => ({text: async () => text}),
    };
  });
}

function orderRow(overrides: Record<string, unknown>) {
  return {
    id: ORDER_ID,
    restaurant_id: 'r1',
    order_number: 59,
    status: 'pending',
    payment_status: 'unpaid',
    total: 5,
    items: [{name: 'Espresso', quantity: 1, price: 5}],
    tab_id: null,
    placed_at: '2026-09-30T07:40:44.238Z',
    ...overrides,
  };
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(PaymentScreen, {
        route: {params: {orderId: ORDER_ID, tableNumber: 0, total: 5, orderNumber: 59}},
        navigation: {
          navigate: jest.fn(),
          goBack: jest.fn(),
          setOptions: jest.fn(),
          addListener: jest.fn(() => jest.fn()),
          replace: jest.fn(),
        },
      } as never),
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return tree;
}

function ordersRequests(): string[] {
  return fetched.filter(u => /\/api\/terminal\/orders(\?|$)/.test(u));
}

beforeEach(() => {
  jest.clearAllMocks();
  installFetch();
  mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: false});
  mockProcessPaymentIntent.mockResolvedValue({success: false, outcomeKind: 'confirmed_failure'});
});

describe('opening the Payment screen reads ONE order', () => {
  it('a non-tab order: one request, ?orderId=<this order>, never the bare list; the total is its own', async () => {
    ordersAnswer = {status: 200, body: {orders: [orderRow({})]}};
    const tree = await mount();

    expect(ordersRequests()).toEqual([
      expect.stringMatching(new RegExp(`/api/terminal/orders\\?orderId=${ORDER_ID}$`)),
    ]);
    const text = renderedText(tree.toJSON());
    expect(text).toContain('NAD5.00');
    expect(text).toContain('Espresso');
    expect(mockGetTabLines).not.toHaveBeenCalled();
  });

  it('a tab order: the same single read, for this order only', async () => {
    ordersAnswer = {status: 200, body: {orders: [orderRow({tab_id: 'tab-9', total: 30})]}};
    await mount();
    expect(ordersRequests()).toEqual([
      expect.stringMatching(new RegExp(`/api/terminal/orders\\?orderId=${ORDER_ID}$`)),
    ]);
  });

  /**
   * KNOWN PRE-EXISTING DEFECT, NOT INTRODUCED OR FIXED HERE (found 2026-09-30, present in 2.40 and
   * 2.41): lib/orderMapper.ts mapRowToOrder never copies `tab_id`, so the order the REAL getOrder
   * returns has none, and resolveOrderMoney takes its no-tab branch -- the Payment screen DISPLAYS
   * the stored original, voided lines included, instead of the tab's live figure. The card charge
   * is unaffected (the reader is sent prepare-payment's server-computed chargeCents). The other
   * PaymentScreen suites cannot see this because they mock getOrder with a tab_id already set.
   *
   * `it.failing` passes while the defect exists. Fixing the mapper turns this RED, which is the
   * prompt to make it a plain `it` -- that fix changes the payment screen's amount and belongs in
   * its own reviewed change.
   */
  it.failing("KNOWN DEFECT: a tab order's live amount comes from its lines (mapper drops tab_id)", async () => {
    ordersAnswer = {status: 200, body: {orders: [orderRow({tab_id: 'tab-9', total: 30})]}};
    mockGetTabLines.mockResolvedValue(
      payloadWith([
        {id: ORDER_ID, total: 30, lines: [line({cents: 2000}), line({cents: 1000, voided: true})]},
      ]),
    );
    const tree = await mount();
    expect(mockGetTabLines).toHaveBeenCalledWith('tab-9', 'terminal-token');
    expect(renderedText(tree.toJSON())).toContain('NAD20.00');
  });

  it('an order the server does not return shows the amount as unavailable, never a guess', async () => {
    ordersAnswer = {status: 200, body: {orders: []}};
    const tree = await mount();
    expect(ordersRequests()).toHaveLength(1);
    const text = renderedText(tree.toJSON());
    expect(text).toContain(LIVE_TOTAL_UNAVAILABLE);
    expect(text).not.toContain('NAD5.00');
  });
});
