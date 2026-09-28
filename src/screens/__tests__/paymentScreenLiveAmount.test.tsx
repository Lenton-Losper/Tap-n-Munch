/**
 * THE CHARGE SCREEN ASKS FOR THE LIVE AMOUNT, NOT orders.total -- sprint 2026-09-28.
 *
 * OrderDetailScreen hands this screen `total: order.total`, the stored ORIGINAL, which keeps
 * counting voided lines. The screen now resolves what the order still owes from its tab's lines
 * (lib/orderLiveMoney) and charges THAT; when it cannot, it charges nothing and says so.
 */
jest.setTimeout(30000);

import React from 'react';
import renderer, {act} from 'react-test-renderer';

const mockGetTerminalInfo = jest.fn();
const mockGetOrder = jest.fn();
const mockGetTabLines = jest.fn();
const mockProcessPaymentIntent = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    getOrder: (...a: unknown[]) => mockGetOrder(...(a as [])),
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

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(PaymentScreen, {
        route: {
          params: {
            orderId: ORDER_ID,
            tableId: 'table-12',
            tableNumber: 12,
            total: 1945, // the STORED original, as OrderDetailScreen passes it
            orderNumber: 160,
            placedAt: '2026-09-28T18:00:00.000Z',
          },
        },
        navigation: {
          navigate: jest.fn(),
          goBack: jest.fn(),
          setOptions: jest.fn(),
          addListener: jest.fn(() => jest.fn()),
        },
      } as never),
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return tree;
}

/** The Riviera original after the three reductions: N$1,945 stored, N$465 live. */
function rivieraOriginalLines(opts: {financials: boolean; allVoided?: boolean}) {
  const voided = opts.allVoided === true;
  return payloadWith(
    [
      {
        id: ORDER_ID,
        total: 1945,
        lines: [
          line({cents: 24000, voided}),
          line({cents: 38000, voided: true}),
          line({cents: 92000, voided: true}),
          line({cents: 18000, voided: true}),
          line({cents: 8000, voided}),
          line({cents: 8000, voided}),
          line({cents: 3500, voided}),
          line({cents: 3000, voided}),
        ],
      },
    ],
    opts.financials
      ? {
          tab: money({original_cents: 194500, voided_cents: voided ? 194500 : 148000}),
          orders: {
            [ORDER_ID]: money({original_cents: 194500, voided_cents: voided ? 194500 : 148000}),
          },
        }
      : undefined,
  );
}

async function pressCharge(tree: renderer.ReactTestRenderer) {
  const buttons = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n.props.children).includes('Process Payment'),
  );
  const button = buttons[buttons.length - 1];
  await act(async () => {
    if (!button.props.disabled) {
      await button.props.onPress();
    }
  });
  return button;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: false});
  mockGetOrder.mockResolvedValue({
    id: ORDER_ID,
    order_number: 160,
    total: 1945,
    payment_status: 'unpaid',
    status: 'completed',
    items: [],
    tab_id: 'tab-riviera',
  });
  mockProcessPaymentIntent.mockResolvedValue({success: false, outcomeKind: 'confirmed_failure'});
});

describe.each([
  ['financials absent', false],
  ['financials present', true],
])('an order reduced by voids, %s', (_label, financials) => {
  it('shows N$465 owed with the original beside it, and charges N$465', async () => {
    mockGetTabLines.mockResolvedValue(rivieraOriginalLines({financials}));
    const tree = await mount();
    const text = renderedText(tree.toJSON());

    expect(mockGetTabLines).toHaveBeenCalledWith('tab-riviera', 'terminal-token');
    expect(text).toContain('NAD465.00');
    expect(text).toContain('NAD1945.00 original · NAD465.00 after voids');

    await pressCharge(tree);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(465);
  });
});

describe('what cannot be charged', () => {
  it('a bill that could not be read shows "unavailable" and charges nothing', async () => {
    mockGetTabLines.mockRejectedValue(new Error('network down'));
    const tree = await mount();
    const text = renderedText(tree.toJSON());

    expect(text).toContain(LIVE_TOTAL_UNAVAILABLE);
    expect(text).not.toContain('NAD1945.00');
    const button = await pressCharge(tree);
    expect(button.props.disabled).toBe(true);
    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
  });

  it('a fully voided order owes N$0 and cannot be charged', async () => {
    mockGetTabLines.mockResolvedValue(rivieraOriginalLines({financials: false, allVoided: true}));
    const tree = await mount();
    const button = await pressCharge(tree);
    expect(button.props.disabled).toBe(true);
    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: an order on no tab charges its total, unchanged', async () => {
    mockGetOrder.mockResolvedValue({
      id: ORDER_ID,
      order_number: 160,
      total: 20,
      payment_status: 'unpaid',
      status: 'completed',
      items: [],
      tab_id: null,
    });
    const tree = await mount();
    await pressCharge(tree);
    expect(mockGetTabLines).not.toHaveBeenCalled();
    expect(mockProcessPaymentIntent.mock.calls[0][0]).toBe(20);
  });
});
