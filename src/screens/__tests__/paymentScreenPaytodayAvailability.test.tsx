/**
 * PAYTODAY MUST SURVIVE THE TRIP FROM /api/terminal/me INTO PaymentScreen'S STATE.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO CATCH
 * ==================================================================================================
 *
 * Digi Cofee's settings row reads ["cash","card","paytoday"]. /api/terminal/me returned
 * paytodayPaymentEnabled: true. resolvePaymentMethodsAvailability returned paytodayEnabled: true.
 * On the physical P5 the payment screen showed Card and Cash only.
 *
 * The whole defect was one destructure:
 *
 *     const {cardEnabled, cashEnabled} = resolvePaymentMethodsAvailability(info);
 *     applyPaymentMethodAvailability(cardEnabled, cashEnabled);
 *
 * Two fields taken, the third dropped, and the third parameter fell through to its `= false`
 * default. Every layer either side was correct.
 *
 * ==================================================================================================
 * WHY THIS TEST MOUNTS THE SCREEN
 * ==================================================================================================
 *
 * Testing resolvePaymentMethodsAvailability in isolation would have passed throughout the outage --
 * it always returned the right answer. The defect lived in the BOUNDARY between the resolver and
 * the screen's state, which only a mounted render crosses.
 *
 * So this drives the real loadPaymentConfig against a faked /api/terminal/me and asserts the chip
 * is rendered. Reintroducing the destructure bug turns it red.
 */
jest.setTimeout(30000);

import React from 'react';
import renderer, {act} from 'react-test-renderer';

import {PAYTODAY_METHOD_LABEL} from '../../constants/paymentCopy';

const mockGetTerminalInfo = jest.fn();
const mockGetOrder = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    getOrder: (...a: unknown[]) => mockGetOrder(...(a as [])),
    getHeldOrphanPayments: jest.fn(async () => []),
    getStrandedOrderRequests: jest.fn(async () => []),
    completePaymentReliably: jest.fn(async () => true),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    closeTable: jest.fn(async () => ({})),
  };
});

jest.mock('../../lib/payment', () => ({
  processPaymentIntent: jest.fn(),
  resolveAmbiguousPaymentWithFinatic: jest.fn(async (_i: string, r: unknown) => r),
  declinedFailureReference: () => 'DECLINED-REF',
  unconfirmedFailureReference: () => 'UNCONFIRMED-REF',
  readHeldOrphanPayments: jest.fn(async () => []),
  acknowledgeHeldOrphanPayment: jest.fn(async () => undefined),
}));

jest.mock('../../lib/storage', () => {
  // SPREAD THE REAL MODULE. Replacing it wholesale removed getHeldOrphanPayments, which a child
  // component imports -- the screen then threw before loadPaymentConfig ever ran, and the failure
  // looked like the availability path being broken.
  const actual = jest.requireActual('../../lib/storage');
  return {
    ...actual,
    getTerminalToken: jest.fn(async () => 'terminal-token'),
  };
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
            orderId: '11111111-1111-4111-8111-111111111111',
            tableId: 'table-5',
            tableNumber: 5,
            total: 20,
            orderNumber: 44,
            placedAt: '2026-09-09T18:00:00.000Z',
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
  // Let loadPaymentConfig settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree;
}

const screenText = (tree: renderer.ReactTestRenderer) => renderedText(tree.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrder.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    order_number: 44,
    total: 20,
    payment_status: 'unpaid',
    status: 'completed',
    items: [],
  });
});

describe('PAYTODAY SURVIVES THE RESOLVER -> SCREEN BOUNDARY', () => {
  it('DIGI COFEE, EXACTLY AS PRODUCTION REPORTS IT: paytoday is offered', async () => {
    /**
     * The production payload for a venue whose payment_methods is ["cash","card","paytoday"].
     * This is the case the P5 got wrong.
     */
    mockGetTerminalInfo.mockResolvedValue({
      cardPaymentEnabled: true,
      cashPaymentEnabled: true,
      paytodayPaymentEnabled: true,
    });

    const text = screenText(await mount());
    expect(text).toContain(PAYTODAY_METHOD_LABEL);
    // And the other two are untouched — the picker offers all three.
    expect(text).toMatch(/Card/);
    expect(text).toMatch(/Cash/);
  });

  it('a venue WITHOUT paytoday does not see it', async () => {
    /**
     * THE NEGATIVE CONTROL, and it is load-bearing: without it, a screen that rendered the chip
     * unconditionally would satisfy the assertion above while showing every venue a method it does
     * not use.
     */
    mockGetTerminalInfo.mockResolvedValue({
      cardPaymentEnabled: true,
      cashPaymentEnabled: true,
      paytodayPaymentEnabled: false,
    });

    const text = screenText(await mount());
    expect(text).not.toContain(PAYTODAY_METHOD_LABEL);
    expect(text).toMatch(/Card/);
  });

  it('an OLDER server that omits the field does not switch it on', async () => {
    /**
     * Card and cash resolve `!== false` so an absent flag means ENABLED — a slow or old server must
     * not strip payment off a working terminal. PayToday resolves `=== true`: absent means OFF,
     * because guessing an opt-in method on would show every venue in the estate a method nobody
     * asked for.
     */
    mockGetTerminalInfo.mockResolvedValue({
      cardPaymentEnabled: true,
      cashPaymentEnabled: true,
    });

    const text = screenText(await mount());
    expect(text).not.toContain(PAYTODAY_METHOD_LABEL);
  });

  it('snake_case from the server works too', async () => {
    // The resolver accepts both spellings; a server that sends only snake_case must still enable it.
    mockGetTerminalInfo.mockResolvedValue({
      card_payment_enabled: true,
      cash_payment_enabled: true,
      paytoday_payment_enabled: true,
    });

    const text = screenText(await mount());
    expect(text).toContain(PAYTODAY_METHOD_LABEL);
  });

  it('a config read that FAILS leaves card and cash, and paytoday off', async () => {
    /**
     * The blip fallback. Card and cash stay on so the floor keeps working; PayToday stays off
     * because absent must never mean enabled for an opt-in method.
     */
    mockGetTerminalInfo.mockRejectedValue(new Error('network down'));

    const text = screenText(await mount());
    expect(text).not.toContain(PAYTODAY_METHOD_LABEL);
    expect(text).toMatch(/Card/);
    expect(text).toMatch(/Cash/);
  });
});

describe('THE RETRY / RECOVERY PATHS CARRY IT TOO', () => {
  /**
   * The same call shape appeared in the PAYMENT_UNCONFIRMED and PAYMENT_FAILED retry buttons: they
   * re-apply availability from local state, and with only two arguments they would have removed
   * PayToday from the picker mid-service — after a failed payment, which is exactly when a waiter
   * needs every method they have.
   *
   * Asserted against source: reaching those buttons needs the screen driven into a failed payment
   * state through the native reader, which this harness deliberately does not have. The question is
   * static — do those call sites pass the third argument?
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {join} = require('path') as {join: (...p: string[]) => string};
  const proc = (globalThis as unknown as {process?: {cwd(): string}}).process;
  const CODE = readFileSync(
    join(proc ? proc.cwd() : '.', 'src', 'screens', 'PaymentScreen.tsx'),
    'utf8',
  );

  it('the screen was read — not an empty match', () => {
    expect(CODE.length).toBeGreaterThan(1000);
  });

  it('EVERY applyPaymentMethodAvailability call passes three arguments', () => {
    /**
     * A census, not a spot check. The defect was one call site out of five; checking a named one
     * would have missed the two retry buttons, which carried the identical shape.
     */
    const calls = CODE.split('applyPaymentMethodAvailability(').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(5);

    const twoArgOnly: string[] = [];
    for (const call of calls) {
      // The argument list up to its closing paren.
      const args = call.slice(0, call.indexOf(');'));
      const commas = args.split(',').filter(a => a.trim().length > 0).length;
      if (commas < 3) twoArgOnly.push(args.replace(/\s+/g, ' ').trim().slice(0, 60));
    }
    expect(twoArgOnly).toEqual([]);
  });

  it('the resolver destructure takes all THREE fields', () => {
    // The exact line that shipped broken.
    expect(CODE.includes('cardEnabled, cashEnabled, paytodayEnabled')).toBe(true);
  });

  it('no two-method assumption decides whether the picker renders', () => {
    /**
     * `bothMethodsEnabled` was a pair, so "show the picker when both are on" hid it at a venue
     * running cash + PayToday and no card. The rule is a COUNT now.
     */
    expect(CODE).not.toMatch(/const bothMethodsEnabled/);
    expect(CODE.includes('enabledMethods.length > 1')).toBe(true);
  });
});
