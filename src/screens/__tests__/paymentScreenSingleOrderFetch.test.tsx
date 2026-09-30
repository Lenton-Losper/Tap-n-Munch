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
const mockCompletePayment = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    // getOrder and getOrders are the REAL implementations -- and so is the mapper under them.
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...(a as [])),
    getHeldOrphanPayments: jest.fn(async () => []),
    getStrandedOrderRequests: jest.fn(async () => []),
    completePayment: (...a: unknown[]) => mockCompletePayment(...(a as [])),
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
import {line, money, payloadWith} from '../../lib/__tests__/helpers/linesPayload';
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
   * REGRESSION -- tab_id (fixed 2026-09-30; the defect shipped in 2.40 and 2.41).
   *
   * lib/orderMapper.ts mapRowToOrder never copied `tab_id`, so the order the REAL getOrder returned
   * had none and resolveOrderMoney took its no-tab branch: the Payment screen showed the stored
   * original -- voided lines included -- and gated cash on it. The card charge was never affected
   * (the reader is sent prepare-payment's server-computed chargeCents).
   *
   * No getOrder mock here: the tab id reaches the screen only through the real mapper, which is the
   * thing this pins. Every other PaymentScreen suite mocks getOrder WITH tab_id set, which is why
   * none of them could see it.
   */
  it("REGRESSION: tab-9, stored NAD30, NAD10 voided -> the screen reads tab-9's lines and shows NAD20.00", async () => {
    ordersAnswer = {status: 200, body: {orders: [orderRow({tab_id: 'tab-9', total: 30})]}};
    mockGetTabLines.mockResolvedValue(
      payloadWith([
        {id: ORDER_ID, total: 30, lines: [line({cents: 2000}), line({cents: 1000, voided: true})]},
      ]),
    );
    const tree = await mount();
    expect(mockGetTabLines).toHaveBeenCalledTimes(1);
    expect(mockGetTabLines).toHaveBeenCalledWith('tab-9', 'terminal-token');
    const text = renderedText(tree.toJSON());
    expect(text).toContain('NAD20.00');
    expect(text).toContain('NAD30.00 original · NAD20.00 after voids');
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

/**
 * WHAT THE SCREEN CHARGES, THROUGH THE REAL MAPPER (A-G).
 *
 * The existing live-amount suite covers these figures with a mocked getOrder that already carries
 * tab_id; these repeat the money cases with nothing between the server row and the screen but the
 * real api.ts and orderMapper.ts. The payment calculation itself is untouched by the fix.
 */
async function pressButton(tree: renderer.ReactTestRenderer, label: string) {
  const buttons = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes(label),
  );
  const button = buttons[buttons.length - 1];
  await act(async () => {
    if (!button.props.disabled) {
      await button.props.onPress();
    }
  });
  return button;
}

function tabOrder(total: number, lines: ReturnType<typeof line>[], financials?: Parameters<typeof payloadWith>[1]) {
  ordersAnswer = {status: 200, body: {orders: [orderRow({tab_id: 'tab-9', total})]}};
  mockGetTabLines.mockResolvedValue(payloadWith([{id: ORDER_ID, total, lines}], financials));
}

describe('A-G: the amount shown and charged', () => {
  beforeEach(() => {
    mockCompletePayment.mockResolvedValue({success: true, canClose: false});
  });

  it('A. a non-tab order: its stored amount, shown and charged', async () => {
    ordersAnswer = {status: 200, body: {orders: [orderRow({total: 5})]}};
    const tree = await mount();
    expect(renderedText(tree.toJSON())).toContain('NAD5.00');
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(5);
    expect(mockGetTabLines).not.toHaveBeenCalled();
  });

  it('B. a plain tab order (nothing voided): the tab figure, which equals the total', async () => {
    tabOrder(30, [line({cents: 3000})]);
    const tree = await mount();
    const text = renderedText(tree.toJSON());
    expect(mockGetTabLines).toHaveBeenCalledWith('tab-9', 'terminal-token');
    expect(text).toContain('NAD30.00');
    expect(text).not.toContain('after voids');
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(30);
  });

  it('C. a tab order with a voided line: the void is excluded from what is charged', async () => {
    tabOrder(30, [line({cents: 2000}), line({cents: 1000, voided: true})]);
    const tree = await mount();
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(20);
  });

  it("D. an amended tab order: the server's CURRENT figure wins over the stale stored total", async () => {
    // Stored total NAD30; since then lines were added and one voided -- the server says NAD40 live.
    tabOrder(30, [line({cents: 2000})], {
      tab: money({original_cents: 4500, voided_cents: 500}),
      orders: {[ORDER_ID]: money({original_cents: 4500, voided_cents: 500})},
    });
    const tree = await mount();
    expect(renderedText(tree.toJSON())).toContain('NAD40.00');
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(40);
  });

  it('E. a partly paid tab order: only what is still owed is payable', async () => {
    // NAD30 live, NAD8 already settled against the first line -> NAD22 owed.
    tabOrder(30, [line({cents: 2000, settledCents: 800}), line({cents: 1000})]);
    const tree = await mount();
    expect(renderedText(tree.toJSON())).toContain('NAD22.00');
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(22);
  });

  it("F. card: the device asks with the live figure; the reader amount is the server's (chargeAmountEndToEnd)", async () => {
    // payment.ts replaces this caller amount with prepare-payment's chargeCents whenever the
    // server sends one -- pinned end to end in src/lib/__tests__/chargeAmountEndToEnd.test.ts.
    tabOrder(30, [line({cents: 2000}), line({cents: 1000, voided: true})]);
    const tree = await mount();
    await pressButton(tree, 'Process Payment');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(20);
    expect(mockProcessPaymentIntent.mock.calls[0][1]).toBe(ORDER_ID);
  });

  it('G. cash: gated on, shown as and reported as the live tab figure', async () => {
    mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: false, cashPaymentEnabled: true});
    tabOrder(30, [line({cents: 2000}), line({cents: 1000, voided: true})]);
    const tree = await mount();

    const tendered = tree.root.find(
      n => n.props?.placeholder === '0.00' && typeof n.props?.onChangeText === 'function',
    );
    await act(async () => {
      tendered.props.onChangeText('20');
    });
    // NAD20 tendered covers the live NAD20. Against the stored NAD30 this stayed disabled. Read
    // before pressing: a successful confirm replaces the button.
    const confirmButtons = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes('Confirm cash'),
    );
    expect(confirmButtons[confirmButtons.length - 1].props.disabled).toBe(false);
    expect(renderedText(tree.toJSON())).toContain('NAD20.00');
    await pressButton(tree, 'Confirm cash');
    expect(mockCompletePayment).toHaveBeenCalledTimes(1);
    expect(mockCompletePayment.mock.calls[0][0]).toBe(ORDER_ID);
    expect(mockCompletePayment.mock.calls[0][2]).toMatchObject({amount: 20, paymentMethod: 'cash'});
  });
});
