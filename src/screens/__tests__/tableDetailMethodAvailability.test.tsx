/**
 * THE TABLE SCREEN OFFERS ONLY THE METHODS THE VENUE TAKES.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 * ==================================================================================================
 *
 * PaymentScreen -- the whole-order Charge screen -- has read cardPaymentEnabled / cashPaymentEnabled
 * from GET /api/terminal/me since it was written. TableDetailScreen read NEITHER. Zero references.
 *
 * So at a card-only venue a waiter was shown Take Cash on the table screen, tapped it, and met a
 * server refusal at the moment of settling -- with a customer waiting. Riviera and FNB ChowNow both
 * sit at payment_methods=["card"] in restaurant_settings, the table that governs this, so it was
 * live at two venues rather than theoretical.
 *
 * The same gap would have swallowed PayToday: "hide it when the venue does not have it on" needs a
 * gate this screen did not have at all, and building a third method on a broken gate would have
 * shipped the same defect three ways instead of two.
 *
 * ==================================================================================================
 * HIDDEN, NOT DISABLED
 * ==================================================================================================
 *
 * A greyed-out Take Cash at a card-only venue is an invitation to keep tapping and then to go
 * looking for a way round. A venue that does not take cash has no cash button. So these assert
 * ABSENCE FROM THE RENDERED TREE, not a disabled prop -- a disabled button would satisfy a weaker
 * check while still being on the screen.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockGetTerminalInfo = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTablesWithMeta: (...a: unknown[]) => mockGetTablesWithMeta(...(a as [])),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...(a as [])),
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    settleTab: jest.fn(),
    allocateLine: jest.fn(),
    settleAllocations: jest.fn(),
    prepareSplitPayment: jest.fn(),
    recordSplitPayment: jest.fn(),
    closeTable: jest.fn(async () => ({})),
    completePaymentReliably: jest.fn(async () => true),
    getAuthorizedUsers: jest.fn(async () => []),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

jest.mock('../../lib/payment', () => ({
  processPaymentIntent: jest.fn(),
  resolveAmbiguousPaymentWithFinatic: jest.fn(async (_i: string, r: unknown) => r),
  declinedFailureReference: () => 'DECLINED-REF',
  unconfirmedFailureReference: () => 'UNCONFIRMED-REF',
}));

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'terminal-token'),
}));

jest.mock('react-native-qrcode-svg', () => 'QRCode');

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const React_ = jest.requireActual('react');
    React_.useEffect(cb, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

import TableDetailScreen from '../TableDetailScreen';

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const PLACED_AT = '2026-09-09T18:00:00.000Z';

function oneOrderTab(): TableWithTab {
  return {
    id: 'table-1',
    table_number: 7,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: 250,
      unpaid_total: 250,
      orders: [
        {
          id: 'order-1',
          order_number: 41,
          total: 250,
          status: 'completed',
          payment_status: 'unpaid',
          member_name: 'Ana',
          items: [],
          placed_at: PLACED_AT,
          can_settle_card: true,
          can_settle_cash: true,
          card_payment_in_flight: false,
          card_in_flight_seconds: null,
        },
      ],
    },
  } as unknown as TableWithTab;
}

function linesPayload() {
  return {
    tab: {id: 'tab-1', table_number: 7, status: 'open', total: 250, opened_at: PLACED_AT, opened_by_user_id: 'u1'},
    orders: [
      {
        order_id: 'order-1',
        order_number: 41,
        order_instructions: null,
        order_total: 250,
        placed_at: PLACED_AT,
        seconds_since_placed: 600,
        lines: [
          {
            id: 'line-steak',
            name_snapshot: 'Ribeye',
            quantity: 1,
            line_note: null,
            route_to: 'kitchen',
            kitchen_state: 'ready',
            bar_state: null,
            is_ready: true,
            is_voided: false,
            unrouted: false,
            total_cents: 25000,
          },
        ],
      },
    ],
    summary: {total_lines: 1, outstanding: 0, ready: 1, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
  };
}

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
      React.createElement(TableDetailScreen, {
        route: {params: {table: oneOrderTab(), owner: null}},
        navigation: {navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), addListener: jest.fn(() => jest.fn())},
      } as never),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

/** Everything the screen currently draws, as one string. */
const screenText = (tree: renderer.ReactTestRenderer) => renderedText(tree.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockResolvedValue({tables: [oneOrderTab()], cardInFlightTimeoutSeconds: 120});
  mockGetTabLines.mockResolvedValue(linesPayload());
});

describe('a venue that takes BOTH (the control)', () => {
  it('shows cash and card', async () => {
    /**
     * THE POSITIVE CONTROL, and this suite is worthless without it. Every other test here asserts
     * that something is ABSENT -- and a screen that failed to render at all, or a text helper that
     * returned an empty string, would satisfy all of them at once.
     */
    mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: true});
    const text = screenText(await mount());
    expect(text).toMatch(/Take Cash/);
    expect(text).toMatch(/Settle Entire Tab/);
  });
});

describe('a CARD-ONLY venue', () => {
  it('does not offer cash anywhere on the screen', async () => {
    // The live case: Riviera and FNB ChowNow are payment_methods=["card"].
    mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: false});
    const text = screenText(await mount());
    expect(text).not.toMatch(/Take Cash/);
    // And the card path is untouched.
    expect(text).toMatch(/Settle Entire Tab/);
  });
});

describe('a CASH-ONLY venue', () => {
  it('does not offer the card buttons', async () => {
    /**
     * The mirror case. It matters for a venue with no Finatic credentials at all: offering a card
     * button there sends a waiter to a reader that cannot be driven, and #107 means there is no
     * fallback -- no credentials means no card, ever.
     */
    mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: false, cashPaymentEnabled: true});
    const text = screenText(await mount());
    expect(text).not.toMatch(/Settle Entire Tab/);
    expect(text).not.toMatch(/Settle Selected/);
    expect(text).toMatch(/Take Cash/);
  });
});

describe('the defaults, which are what protects a live table', () => {
  it('a config read that FAILS leaves both methods offered', async () => {
    /**
     * Failing to read the config is not evidence that a venue stopped taking cash. Turning a method
     * off on a network blip would strand a table mid-service, and the server refuses a disallowed
     * settlement regardless -- this decides which buttons to draw, not what is permitted.
     */
    mockGetTerminalInfo.mockRejectedValue(new Error('network down'));
    const text = screenText(await mount());
    expect(text).toMatch(/Take Cash/);
    expect(text).toMatch(/Settle Entire Tab/);
  });

  it('a response that OMITS the flags leaves both offered', async () => {
    /**
     * resolvePaymentMethodsAvailability treats anything that is not an explicit `false` as enabled.
     * An older server that does not send these fields must not silently disable payment.
     */
    mockGetTerminalInfo.mockResolvedValue({permissions: ['orders:update']});
    const text = screenText(await mount());
    expect(text).toMatch(/Take Cash/);
    expect(text).toMatch(/Settle Entire Tab/);
  });

  it('it asks the server at all', async () => {
    // The whole defect was that this screen never asked. If the call is dropped in a refactor,
    // every assertion above still passes on the defaults.
    mockGetTerminalInfo.mockResolvedValue({cardPaymentEnabled: true, cashPaymentEnabled: true});
    await mount();
    expect(mockGetTerminalInfo).toHaveBeenCalled();
  });
});
