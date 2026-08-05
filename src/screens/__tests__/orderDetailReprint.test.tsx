/**
 * #101 — a button must show it is busy from the moment it is tapped.
 *
 * "Reprint Receipt" claimed its in-flight flag only AFTER `await getReceiptPrintingEnabled()`,
 * an async storage read. For the whole of that read the button stayed enabled and still read
 * "Reprint Receipt", so a second tap re-entered the handler, passed the `reprinting` guard
 * (still false) and printed a second physical receipt.
 *
 * Reprint is a printing action, not a money one — printReceiptForOrder GETs the already-issued
 * receipt and adds a delivery row; it does not re-issue, settle or mutate payment state. The
 * settle / cash / payment buttons are deliberately NOT touched here.
 *
 * Assertions read the rendered screen: the label must be replaced by a spinner while the
 * action is in flight.
 */
import React from 'react';
import renderer from 'react-test-renderer';

import type {Order} from '../../types';

// ---- deferred control over the storage read the handler awaits ----
let mockReceiptPrintingEnabled: () => Promise<boolean> = async () => true;

jest.mock('../../lib/receiptPrintSettings', () => ({
  getReceiptPrintingEnabled: () => mockReceiptPrintingEnabled(),
  describeReceiptPrintError: () => 'Printing failed',
}));

const mockPrintReceiptForOrder = jest.fn(async () => ({success: true}));
jest.mock('../../lib/receiptPrinting', () => ({
  printReceiptForOrder: (...args: unknown[]) => mockPrintReceiptForOrder(...(args as [])),
}));

const mockOrder = {
  id: 'order-1',
  status: 'completed',
  payment_status_derived: 'paid',
  channel: 'table',
  table_number: 4,
  table_id: 'table-1',
  items: [],
  total: 100,
  created_at: '2026-08-05T10:00:00.000Z',
} as unknown as Order;

jest.mock('../../lib/api', () => ({
  getOrder: jest.fn(async () => mockOrder),
  updateOrderStatus: jest.fn(async () => mockOrder),
}));
jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'token'),
}));

// Navigation is the untransformed-ESM package that breaks App.test.tsx; the screen only needs
// useFocusEffect to fire once and a navigate/goBack that are never asserted on.
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const ReactActual = require('react');
    ReactActual.useEffect(() => {
      cb();
    }, [cb]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

import OrderDetailScreen from '../OrderDetailScreen';

/** The screen reads only route.params.orderId; the rest of the navigator props are unused. */
const screenProps = {
  route: {params: {orderId: 'order-1'}},
} as unknown as React.ComponentProps<typeof OrderDetailScreen>;

/** Text of a React element subtree, used to locate a button by its label. */
function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  const props = (node as {props?: {children?: unknown}}).props;
  return props ? elementText(props.children) : '';
}

/** Every string the screen renders — the artefact a member of staff actually looks at. */
function renderedText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as {children?: unknown[]} | null)?.children;
    if (children) children.forEach(walk);
  };
  walk(json);
  return out.join('\n');
}

async function flush() {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Mounting a screen pays for transforming react-native's whole module graph, which on a cold
 * jest cache is measured at 24s here and 38s for the Diagnostics suite. That is a fixed,
 * deterministic setup cost, not a race — but it is far above jest's 5s default, and a test
 * aborted mid-flight by that default is what previously leaked work into the next one.
 */
jest.setTimeout(120000);

describe('#101 Reprint Receipt in-flight feedback', () => {
  /** Resolvers for every storage read currently held open, so none can outlive its test. */
  let pendingReads: Array<(enabled: boolean) => void> = [];
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    mockPrintReceiptForOrder.mockClear();
    pendingReads = [];
    mockReceiptPrintingEnabled = async () => true;
  });

  afterEach(async () => {
    // Nothing may stay in flight across tests. An abandoned reprint — from a failure, or from
    // a test aborted by the timeout — would otherwise finish during the NEXT test and land its
    // printReceiptForOrder call after that test's mockClear(), inflating its count. Resolving
    // false unwinds each handler through its `finally` without printing.
    await renderer.act(async () => {
      pendingReads.forEach(resolve => resolve(false));
    });
    await flush();
    await renderer.act(async () => {
      trees.forEach(tree => tree.unmount());
    });
    trees = [];
  });

  async function mountScreen(): Promise<renderer.ReactTestRenderer> {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<OrderDetailScreen {...screenProps} />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  /**
   * Makes every subsequent read hang until explicitly released. Each resolver is kept, not
   * just the most recent — otherwise a second entry into the handler would replace the first
   * one's resolver and the first call would never complete, hiding the double-print.
   */
  function holdReadsOpen() {
    mockReceiptPrintingEnabled = () =>
      new Promise<boolean>(resolve => {
        pendingReads.push(resolve);
      });
  }

  function reprintButton(tree: renderer.ReactTestRenderer) {
    return tree.root.find(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes('Reprint Receipt'),
    );
  }

  async function releaseReads() {
    await renderer.act(async () => {
      pendingReads.splice(0).forEach(resolve => resolve(true));
    });
    await flush();
  }

  it('swaps the label for a spinner while the action is in flight', async () => {
    const tree = await mountScreen();

    // The button is on screen and idle.
    expect(renderedText(tree.toJSON())).toContain('Reprint Receipt');

    holdReadsOpen();
    const button = reprintButton(tree);
    await renderer.act(async () => {
      button.props.onPress();
    });

    // While the read is still pending the label must be gone, replaced by the spinner.
    expect(renderedText(tree.toJSON())).not.toContain('Reprint Receipt');

    await releaseReads();
  });

  it('a second tap during that window does not print a second receipt', async () => {
    const tree = await mountScreen();

    holdReadsOpen();
    const button = reprintButton(tree);

    // Two taps landing inside the same pending read, as a double-tap does.
    await renderer.act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    await releaseReads();

    expect(mockPrintReceiptForOrder).toHaveBeenCalledTimes(1);
  });
});
