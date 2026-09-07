/**
 * ONE TAP, ONE SPINNER.
 *
 * ==================================================================================================
 * THE PHYSICAL EVIDENCE THIS EXISTS TO CHARACTERISE
 * ==================================================================================================
 *
 * On APK 135 at Digi Cofee, one payment button was tapped and at least one OTHER settlement button
 * on the same bar also appeared to be working. Nothing was double-charged -- the re-entrancy ref,
 * the disabled props and the server's atomic claim all held -- but a waiter cannot tell a button
 * that is BUSY from a button that is MERELY BLOCKED, and on the money path that is the difference
 * between waiting and reaching for cash.
 *
 * ==================================================================================================
 * DISABLED IS NOT LOADING, AND THE DIFFERENCE IS THE WHOLE POINT
 * ==================================================================================================
 *
 *   DISABLED  this button cannot be used right now.        Correct for every other button.
 *   LOADING   THIS button's work is in progress.           Correct for exactly one button.
 *
 * `settling` is a single boolean shared by "Settle Selected" and "Settle Entire Tab". It is right
 * for BOTH to go disabled when either is pressed. It is wrong for both to SPIN, because only one of
 * them was pressed.
 *
 * So these tests assert the two properties separately and never conflate them: a disabled assertion
 * can be satisfied by a spinning button, which is precisely the confusion being tested for.
 *
 * ==================================================================================================
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ==================================================================================================
 *
 * Nothing here touches what is charged, which orders are settled, or the re-entrancy guard. Those
 * are covered by settleSelectedOrders, takePaymentByItem and paymentNativeBoundary, and this suite
 * must not become a second, weaker copy of them. It asserts pixels of feedback and nothing else.
 */
jest.setTimeout(30000);

import React from 'react';
import {ActivityIndicator, Alert, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import type {ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockGetTerminalInfo = jest.fn();
const mockSettleTab = jest.fn();
const mockPrepareSplitPayment = jest.fn();
const mockProcessPaymentIntent = jest.fn();
/**
 * THE FIRST AWAIT ON BOTH SETTLE PATHS, which is why it is the one held open.
 *
 * A ticked line nobody has split yet must be allocated before it can be charged, and the cash path
 * does the same thing for the same reason. Holding it open parks EITHER path in flight with the
 * bar rendered -- the state the P5 was in.
 *
 * Stubbing it to return `undefined` instead throws inside the same act(), and the screen has
 * already alerted and recovered before any assertion runs. The first draft of this suite did
 * exactly that and read as "nothing ever spins", which is a false GREEN on the very defect it
 * exists to catch.
 */
const mockAllocateLine = jest.fn();
const mockSettleAllocations = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTablesWithMeta: (...a: unknown[]) => mockGetTablesWithMeta(...(a as [])),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...(a as [])),
    getTerminalInfo: (...a: unknown[]) => mockGetTerminalInfo(...(a as [])),
    settleTab: (...a: unknown[]) => mockSettleTab(...(a as [])),
    prepareSplitPayment: (...a: unknown[]) => mockPrepareSplitPayment(...(a as [])),
    prepareTerminalPayment: jest.fn(async () => ({chargeCents: 25000, tipCents: 0})),
    allocateLine: (...a: unknown[]) => mockAllocateLine(...(a as [])),
    settleAllocations: (...a: unknown[]) => mockSettleAllocations(...(a as [])),
    recordSplitPayment: jest.fn(),
    closeTable: jest.fn(async () => ({})),
    completePaymentReliably: jest.fn(async () => true),
    getAuthorizedUsers: jest.fn(async () => []),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
    authorizeTerminalAction: jest.fn(async () => ({token_id: 'tok-1'})),
  };
});

jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...a: unknown[]) => mockProcessPaymentIntent(...(a as [])),
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

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const PLACED_AT = '2026-09-09T18:00:00.000Z';

/**
 * TWO lines on one order, and that is load-bearing.
 *
 * With a single line the selection covers a whole order and planFor sends it down the whole-order
 * route. Two lines let one be ticked, which is a genuine part-order payment -- the split path the
 * waiter was actually on when they saw this.
 */
function twoLineTab(): TableWithTab {
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
  const line = (id: string, name: string, cents: number) => ({
    id,
    name_snapshot: name,
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'ready',
    bar_state: null,
    is_ready: true,
    is_voided: false,
    unrouted: false,
    total_cents: cents,
  });
  return {
    tab: {
      id: 'tab-1',
      table_number: 7,
      status: 'open',
      total: 250,
      opened_at: PLACED_AT,
      opened_by_user_id: 'u1',
    },
    orders: [
      {
        order_id: 'order-1',
        order_number: 41,
        order_instructions: null,
        order_total: 250,
        placed_at: PLACED_AT,
        seconds_since_placed: 600,
        lines: [line('line-steak', 'Ribeye', 20000), line('line-coke', 'Coke', 5000)],
      },
    ],
    summary: {total_lines: 2, outstanding: 0, ready: 2, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
  };
}

// ------------------------------------------------------------------ tree helpers

/** Every string rendered inside this instance, flattened. */
function textOf(inst: ReactTestInstance): string {
  const flat = (c: unknown): string => {
    if (c == null || typeof c === 'boolean') return '';
    if (Array.isArray(c)) return c.map(flat).join(' ');
    if (typeof c === 'object') {
      return flat((c as {props?: {children?: unknown}}).props?.children);
    }
    return String(c);
  };
  return inst.findAllByType(Text).map(t => flat(t.props.children)).join(' ');
}

/**
 * The innermost pressable whose label contains `label`.
 *
 * Innermost, because LoadingButton is a pressable wrapping a Pressable and both carry onPress and
 * disabled; the inner one is the thing the user's finger lands on.
 */
function buttonWith(tree: renderer.ReactTestRenderer, label: string): ReactTestInstance {
  const hits = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && textOf(n).includes(label),
    {deep: true},
  );
  if (hits.length === 0) throw new Error(`no pressable rendering "${label}"`);
  return hits[hits.length - 1];
}

const isSpinning = (inst: ReactTestInstance) =>
  inst.findAllByType(ActivityIndicator).length > 0;

/** Spinners anywhere on the screen. One tap should produce exactly one. */
const spinnerCount = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(ActivityIndicator).length;

/**
 * Settle Selected by testID, because while it is busy its LABEL IS GONE.
 *
 * It is a plain Pressable that swaps its text for the spinner, so buttonWith() cannot find it in
 * exactly the state these tests care about. The two LoadingButtons dim their labels instead and
 * stay findable by name.
 */
const byTestID = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findByProps({testID: id});

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(TableDetailScreen, {
        route: {params: {table: twoLineTab(), owner: null}},
        navigation: {
          navigate: jest.fn(),
          goBack: jest.fn(),
          setOptions: jest.fn(),
          addListener: jest.fn(() => jest.fn()),
        },
      } as never),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

/** Tick ONE line, which raises the selection bar carrying all three buttons. */
async function selectOneLine(tree: renderer.ReactTestRenderer) {
  const row = tree.root.findByProps({testID: 'take-payment-line-line-steak'});
  await act(async () => {
    row.props.onPress();
  });
}

/** `target` is a testID when it is hyphenated, and a visible label when it has spaces. */
async function press(tree: renderer.ReactTestRenderer, target: string) {
  const button = target.includes(' ')
    ? buttonWith(tree, target)
    : byTestID(tree, target);
  await act(async () => {
    button.props.onPress();
  });
}

/** Take Cash always offers attribution first. Skip records the settlement without a PIN. */
async function skipThePinPrompt() {
  const call = alertSpy.mock.calls.find(c => String(c[0]) === 'Staff PIN');
  if (!call) throw new Error('Take Cash did not offer the PIN prompt');
  const buttons = call[2] as Array<{text: string; onPress?: () => void}>;
  const skip = buttons.find(b => b.text === 'Skip');
  if (!skip?.onPress) throw new Error('no Skip on the PIN prompt');
  await act(async () => {
    skip.onPress!();
  });
}

/** A payment that is launched and never comes back, so the in-flight render can be inspected. */
const neverResolves = () => new Promise(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockResolvedValue({
    tables: [twoLineTab()],
    cardInFlightTimeoutSeconds: 120,
  });
  mockGetTabLines.mockResolvedValue(linesPayload());
  mockGetTerminalInfo.mockResolvedValue({
    cardPaymentEnabled: true,
    cashPaymentEnabled: true,
  });
  mockAllocateLine.mockImplementation(neverResolves);
  mockSettleAllocations.mockImplementation(neverResolves);
  mockPrepareSplitPayment.mockImplementation(neverResolves);
  mockProcessPaymentIntent.mockImplementation(neverResolves);
  mockSettleTab.mockImplementation(neverResolves);
});

// ==================================================================================================
// A — the control
// ==================================================================================================

describe('A. idle', () => {
  it('renders all three settlement buttons and spins none of them', async () => {
    /**
     * THE POSITIVE CONTROL FOR EVERY "does not spin" BELOW. A screen that failed to render, or a
     * spinner helper that always returned zero, would satisfy those assertions vacuously. This
     * proves the three buttons exist to be spun in the first place.
     */
    const tree = await mount();
    await selectOneLine(tree);

    expect(byTestID(tree, 'settle-selected')).toBeTruthy();
    expect(buttonWith(tree, 'Settle Entire Tab')).toBeTruthy();
    expect(buttonWith(tree, 'Take Cash')).toBeTruthy();
    expect(spinnerCount(tree)).toBe(0);
  });
});

// ==================================================================================================
// B, C, D — one tap on Settle Selected
// ==================================================================================================

describe('B. Settle Selected, pressed', () => {
  it('leaves exactly one spinner, and it is on Settle Selected', async () => {
    /**
     * THE OTHER HALF OF THE CONTROL PAIR. If pressing produced no spinner at all, C, D and G would
     * all pass while the screen gave a waiter no feedback whatsoever -- a false green on the very
     * defect this suite exists for. An earlier draft of this harness did exactly that, by stubbing
     * allocateLine so it threw inside the same act().
     *
     * Counting rather than only naming also catches a FOURTH button growing a spinner later.
     */
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');

    expect(spinnerCount(tree)).toBe(1);
    expect(isSpinning(byTestID(tree, 'settle-selected'))).toBe(true);
  });
});

describe('C. Settle Selected, pressed', () => {
  it('does NOT spin Settle Entire Tab', async () => {
    /**
     * THE REPORTED DEFECT, stated on its own. Both buttons read `settling`, so `loading={settling}`
     * drew a spinner over a button nobody touched -- and LoadingButton without an icon overlays it
     * on a dimmed label, which is precisely what "appears to be loading" looks like on a P5.
     */
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');

    // Findable by name throughout: LoadingButton dims the label, it does not remove it.
    expect(isSpinning(buttonWith(tree, 'Settle Entire Tab'))).toBe(false);
  });

  it('still DISABLES Settle Entire Tab', async () => {
    // The half that was always right, pinned so a fix for the spinner cannot quietly re-enable a
    // second route to the card reader.
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');

    expect(buttonWith(tree, 'Settle Entire Tab').props.disabled).toBe(true);
  });
});

describe('D. Settle Selected, pressed', () => {
  it('disables Take Cash WITHOUT spinning it', async () => {
    /**
     * The distinction as an assertion. Take Cash must go dead -- cash taken while a card attempt is
     * live is a double collection -- but it must not claim to be busy.
     */
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');

    const cash = buttonWith(tree, 'Take Cash');
    expect(cash.props.disabled).toBe(true);
    expect(isSpinning(cash)).toBe(false);
  });
});

// ==================================================================================================
// E, F, G — the same tap in the other direction
// ==================================================================================================

describe('E. Take Cash, pressed', () => {
  it('spins Take Cash', async () => {
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'Take Cash');
    await skipThePinPrompt();

    expect(isSpinning(buttonWith(tree, 'Take Cash'))).toBe(true);
  });
});

describe('F. Take Cash, pressed', () => {
  it('disables BOTH card buttons', async () => {
    /**
     * THE SECOND DEFECT, AND IT WAS NOT SYMMETRIC. Settle Selected read `disabled={settling}` and
     * Settle Entire Tab `disabled={settling || unpaidOrders.length === 0}`; neither consulted
     * `cashSettling`, so while cash was being taken both card buttons stayed lit and pressable.
     *
     * A tap was caught by settleInFlight.current and returned SILENTLY -- no charge, no alert, no
     * feedback. Fail-safe as to money, and the worst possible feedback: a live button that does
     * nothing reads as a frozen terminal.
     *
     * This asserts the buttons are DISABLED, so reintroducing the defect fails here for the right
     * reason -- the card button becomes tappable again -- and not through some neighbouring state.
     */
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'Take Cash');
    await skipThePinPrompt();

    expect(byTestID(tree, 'settle-selected').props.disabled).toBe(true);
    expect(buttonWith(tree, 'Settle Entire Tab').props.disabled).toBe(true);
  });
});

describe('G. Take Cash, pressed', () => {
  it('does not spin either card button', async () => {
    // Disabled, not busy -- D's rule pointing the other way.
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'Take Cash');
    await skipThePinPrompt();

    expect(isSpinning(byTestID(tree, 'settle-selected'))).toBe(false);
    expect(isSpinning(buttonWith(tree, 'Settle Entire Tab'))).toBe(false);
    expect(spinnerCount(tree)).toBe(1);
  });
});

// ==================================================================================================
// H, I, J
// ==================================================================================================

describe('H. after a refusal', () => {
  it('clears every loading state and re-arms every button', async () => {
    /**
     * A fix that stopped a spinner by never starting it would satisfy C. This asserts the state
     * machine still closes: a split payment refused BEFORE the reader charged nothing, so the bar
     * must come back exactly as it was found -- including busyButton, whose staleness would
     * otherwise silence the next tap's spinner.
     */
    mockAllocateLine.mockRejectedValue(new Error('nope'));
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spinnerCount(tree)).toBe(0);
    expect(byTestID(tree, 'settle-selected').props.disabled).toBe(false);
    expect(buttonWith(tree, 'Settle Entire Tab').props.disabled).toBe(false);
    expect(buttonWith(tree, 'Take Cash').props.disabled).toBe(false);
  });

  it('a second tap after the refusal spins again', async () => {
    /**
     * The specific way a busyButton left set would fail: everything looks re-armed, and then the
     * NEXT payment runs with no spinner at all. Only a second press catches that.
     */
    mockAllocateLine.mockRejectedValueOnce(new Error('nope'));
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'settle-selected');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    mockAllocateLine.mockImplementation(neverResolves);
    await press(tree, 'settle-selected');

    expect(isSpinning(byTestID(tree, 'settle-selected'))).toBe(true);
    expect(spinnerCount(tree)).toBe(1);
  });
});

describe('I. a rapid double tap', () => {
  it('starts exactly one payment attempt', async () => {
    /**
     * BOTH TAPS DISPATCHED IN ONE BATCH, which is the case `disabled` cannot cover: it is computed
     * from React state, and `setSettling(true)` does not take effect until the next render, so both
     * presses find the button enabled. settleInFlight is a ref and updates synchronously, so the
     * second returns before anything is charged.
     *
     * Pressing the captured instance twice inside a single act() reproduces that exactly. This test
     * is here because the fix touches the loading path that sits beside the mutex -- the mutex
     * itself is unchanged, and this proves it.
     */
    const tree = await mount();
    await selectOneLine(tree);
    const button = byTestID(tree, 'settle-selected');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });

    expect(mockAllocateLine).toHaveBeenCalledTimes(1);
    expect(spinnerCount(tree)).toBe(1);
  });
});

describe('J. Settle Entire Tab, pressed', () => {
  it('spins only Settle Entire Tab', async () => {
    /**
     * The mirror of B, and the reason `busyButton` is set by the HANDLERS rather than by runSettle:
     * runSettle serves both card buttons and cannot tell which one was pressed.
     *
     * Settling the entire tab clears the line selection, so the bar switches from the selection bar
     * to the default one and Settle Selected is unmounted -- the spinner count carries the "and
     * nothing else spins" half here.
     */
    const tree = await mount();
    await selectOneLine(tree);
    await press(tree, 'Settle Entire Tab');

    expect(isSpinning(buttonWith(tree, 'Settle Entire Tab'))).toBe(true);
    expect(isSpinning(buttonWith(tree, 'Take Cash'))).toBe(false);
    expect(spinnerCount(tree)).toBe(1);
  });
});
