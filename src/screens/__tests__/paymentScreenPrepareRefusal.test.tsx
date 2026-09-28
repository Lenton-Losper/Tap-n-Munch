/**
 * THE CHARGE SCREEN, WHEN prepare-payment REFUSES BEFORE THE READER OPENS (Sprint 2026-09-29,
 * F-TERMPAY task 3).
 *
 * A typed refusal (the order is already paid / cancelled / held, or owes nothing) is not a card
 * outcome: nothing was presented. The screen says why, re-reads the order, and stops -- no Finatic
 * verify, no FAILED report to the server, no retry. Harness adapted from paymentScreenLiveAmount.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';

const mockGetTerminalInfo = jest.fn();
const mockGetOrder = jest.fn();
const mockProcessPaymentIntent = jest.fn();
const mockCompletePaymentReliably = jest.fn(async () => true);
const mockCompletePayment = jest.fn();
const mockResolveAmbiguous = jest.fn(async (_i: string, r: unknown) => r);

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    getOrder: (...a: unknown[]) => mockGetOrder(...(a as [])),
    getTabLines: jest.fn(async () => null),
    getHeldOrphanPayments: jest.fn(async () => []),
    getStrandedOrderRequests: jest.fn(async () => []),
    completePayment: (...a: unknown[]) => mockCompletePayment(...(a as [])),
    completePaymentReliably: (...a: unknown[]) => mockCompletePaymentReliably(...(a as [])),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    closeTable: jest.fn(async () => ({})),
  };
});

jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...a: unknown[]) => mockProcessPaymentIntent(...(a as [])),
  resolveAmbiguousPaymentWithFinatic: (...a: unknown[]) =>
    mockResolveAmbiguous(...(a as [string, unknown])),
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
import {ApiRequestError} from '../../lib/api';
import {
  PAYMENT_HELD_BODY,
  PAYMENT_HELD_TITLE,
  PREPARE_REFUSAL_ORDER_CHANGED,
  PREPARE_REFUSAL_CANCELLED,
  PREPARE_REFUSAL_HELD,
  PREPARE_REFUSAL_PAID,
  PREPARE_REFUSAL_TITLE,
} from '../../constants/settlementRefusalCopy';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

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
            total: 20,
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

async function pressCharge(tree: renderer.ReactTestRenderer) {
  const buttons = tree.root.findAll(
    n =>
      typeof n.props?.onPress === 'function' &&
      renderedText(n.props.children).includes('Process Payment'),
  );
  const button = buttons[buttons.length - 1];
  await act(async () => {
    if (!button.props.disabled) {
      await button.props.onPress();
    }
  });
}

function byTestId(tree: renderer.ReactTestRenderer, id: string): string | null {
  const hits = tree.root.findAll(n => n.props?.testID === id && typeof n.type !== 'string');
  return hits.length ? renderedText(hits[0].props.children) : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCompletePayment.mockResolvedValue({success: true, canClose: false});
  mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: false});
  // A tab-less order: charges its total, so the refusal is the only thing under test.
  mockGetOrder.mockResolvedValue({
    id: ORDER_ID,
    order_number: 160,
    total: 20,
    payment_status: 'unpaid',
    status: 'completed',
    items: [],
    tab_id: null,
  });
});

describe('a typed prepare refusal on the Charge screen', () => {
  it.each([
    ['ALREADY_PAID', [], PREPARE_REFUSAL_PAID],
    ['ORDER_CANCELLED', [], PREPARE_REFUSAL_CANCELLED],
    [
      'SETTLEMENT_SET_NOT_CLAIMABLE',
      [{orderId: ORDER_ID, orderNumber: 160, reason: 'held'}],
      PREPARE_REFUSAL_HELD,
    ],
    ['ORDER_CHANGED_DURING_PREPARE', [], PREPARE_REFUSAL_ORDER_CHANGED],
  ])('%s: the reason in words, the order re-read, nothing reported or retried', async (code, notClaimable, sentence) => {
    mockProcessPaymentIntent.mockResolvedValueOnce({
      success: false,
      outcomeKind: 'not_started',
      prepareRefusal: {code, notClaimable, orderIdsOwingNothing: []},
    });
    const tree = await mount();
    const readsBefore = mockGetOrder.mock.calls.length;

    await pressCharge(tree);

    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    const [title, body] = mockAlert.mock.calls[mockAlert.mock.calls.length - 1] as [string, string];
    expect(title).toBe(PREPARE_REFUSAL_TITLE);
    expect(body.startsWith(sentence)).toBe(true);
    expect(mockResolveAmbiguous).not.toHaveBeenCalled();
    expect(mockCompletePaymentReliably).not.toHaveBeenCalled();
    expect(mockGetOrder.mock.calls.length).toBeGreaterThan(readsBefore);
    // Not the FAILED card, whose "Try again" would re-present the same refused order.
    expect(renderedText(tree.toJSON())).not.toContain('FAILED');
  });

  it('POSITIVE CONTROL: a plain not_started is still reported and shown as a failure', async () => {
    mockProcessPaymentIntent.mockResolvedValueOnce({
      success: false,
      outcomeKind: 'not_started',
      error: 'The card machine could not be started',
    });
    const tree = await mount();
    await pressCharge(tree);
    expect(mockCompletePaymentReliably).toHaveBeenCalledTimes(1);
  });
});

describe('409 ORDER_CHANGED_DURING_PAYMENT: the card WAS charged and the order is held', () => {
  const charged = {
    success: true,
    reference: 'GW-REF-1',
    voucherNo: 'V-77',
    businessOrderNo: 'FT-1',
  };

  it('says the payment was taken and held, shows the reference, and never reports failure or retries', async () => {
    mockProcessPaymentIntent.mockResolvedValueOnce(charged);
    mockCompletePayment.mockRejectedValue(
      new ApiRequestError('The card was charged, but the bill changed.', 409, {
        code: 'ORDER_CHANGED_DURING_PAYMENT',
      }),
    );
    const tree = await mount();
    await pressCharge(tree);

    expect(byTestId(tree, 'payment-success-title')).toBe(PAYMENT_HELD_TITLE);
    expect(byTestId(tree, 'payment-held-note')).toBe(PAYMENT_HELD_BODY);
    expect(byTestId(tree, 'payment-held-reference')).toContain('V-77');
    // Reported once, as a success; never as a failure, never re-verified, never charged again.
    expect(mockCompletePayment).toHaveBeenCalledTimes(1);
    expect(mockCompletePaymentReliably).not.toHaveBeenCalled();
    expect(mockResolveAmbiguous).not.toHaveBeenCalled();
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    const text = renderedText(tree.toJSON());
    expect(text).not.toContain('FAILED');
    expect(text).not.toContain('Try again');
    expect(text).not.toContain('Process Payment');
  });

  it('POSITIVE CONTROL: an unrelated 409 on the success report still goes to recovery, not the held screen', async () => {
    mockProcessPaymentIntent.mockResolvedValueOnce(charged);
    mockCompletePayment.mockRejectedValue(
      new ApiRequestError('The order may already be paid.', 409, {code: 'PAYMENT_CLAIM_CONFLICT'}),
    );
    const tree = await mount();
    await pressCharge(tree);
    expect(mockResolveAmbiguous).toHaveBeenCalled();
    expect(byTestId(tree, 'payment-held-note')).toBeNull();
  });
});
