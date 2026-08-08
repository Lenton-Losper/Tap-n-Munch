/**
 * #101 — a button must not act twice on a double-tap.
 *
 * "Test Print" guarded re-entry with `if (!printerConfig || testPrinting) return;` and
 * `disabled={testPrinting}`. Both read state, and state is a render behind: two taps landing in
 * the same frame both see `testPrinting === false` and both get through, so the terminal spits
 * out two physical test prints from one double-tap. This is the same defect 175d75e fixed on
 * Reprint Receipt, and the fix is the same — a ref that flips synchronously.
 *
 * Test Print is a printing action, not a money one: it composes local diagnostic lines and
 * sends them to the printer. It does not touch an order, a payment or a settlement. The
 * settle / cash / payment / refund buttons are deliberately NOT part of this.
 *
 * Assertions read the rendered screen and count what reached the native printer entry.
 */
import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// src/constants throws at module scope when RuntimeConfig.API_BASE_URL is absent, which it is
// under jest — there is no native build here. The screen only reads APP_VERSION from it.
jest.mock('../../constants', () => ({APP_VERSION: '1.79'}));

const builtInConfig = {
  id: 'cfg-1',
  terminal_id: 'terminal-1',
  connection_type: 'BUILTIN',
  printer_name: 'Built-in Printer',
  printer_address: 'BUILTIN',
  paper_width_mm: 58,
  character_width: null,
};

/** Resolvers for every print currently held open, so a second entry is visible. */
let pendingPrints: Array<(v: {success: boolean}) => void> = [];
const mockPrintBuiltInJob = jest.fn(
  () =>
    new Promise<{success: boolean}>(resolve => {
      pendingPrints.push(resolve);
    }),
);

jest.mock('../../lib/api', () => ({
  getPrinterConfig: jest.fn(async () => builtInConfig),
  deletePrinterConfig: jest.fn(async () => undefined),
}));
jest.mock('../../lib/wiseSdk6Printer', () => ({
  printBuiltInJob: (...a: unknown[]) => mockPrintBuiltInJob(...(a as [])),
  getBuiltInPrinterStatus: jest.fn(
    async () => ({connected: true, hasPaper: true}),
  ),
  describeWiseSdk6PrinterError: () => 'Print failed',
}));
jest.mock('../../lib/printer', () => ({
  getPrinterStatus: jest.fn(async () => ({connected: false, id: null})),
  runBluetoothPrintJob: jest.fn(async () => ({success: true})),
  describePrinterError: () => 'Print failed',
}));
jest.mock('../../lib/receiptPrintSettings', () => ({
  getReceiptPrintingEnabled: jest.fn(async () => true),
  setReceiptPrintingEnabled: jest.fn(async () => undefined),
  recordLastPrintResult: jest.fn(async () => undefined),
}));
jest.mock('../../lib/storage', () => ({
  clearAllData: jest.fn(async () => undefined),
  getRestaurantName: jest.fn(async () => 'FlashTap'),
  getTerminalId: jest.fn(async () => 'terminal-1'),
  getTerminalToken: jest.fn(async () => 'token'),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({signOut: jest.fn()}),
}));
jest.mock('../../context/StreamContext', () => ({
  useStreamConnection: () => ({connectionStatus: 'connected'}),
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');
// Both are rendered inside Modals that stay closed; stubbing avoids their module graphs.
jest.mock('../DiagnosticsScreen', () => 'DiagnosticsScreen');
jest.mock('../PrinterPickerScreen', () => 'PrinterPickerScreen');

import SettingsScreen from '../SettingsScreen';

/** Text of a React element subtree, used to locate a button by its label. */
function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  const props = (node as {props?: {children?: unknown}}).props;
  return props ? elementText(props.children) : '';
}

/** Every string the screen renders — what a member of staff actually looks at. */
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

// Mounting a screen pays for transforming react-native's whole module graph — a fixed cost
// measured in tens of seconds on a cold cache, far above jest's 5s default. Not a race.
jest.setTimeout(120000);

describe('#101 Test Print in-flight feedback', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    mockPrintBuiltInJob.mockClear();
    pendingPrints = [];
  });

  afterEach(async () => {
    // Nothing may stay in flight across tests: an abandoned print would land its call during
    // the NEXT test, after that test's mockClear(), and inflate its count.
    await renderer.act(async () => {
      pendingPrints.splice(0).forEach(resolve => resolve({success: true}));
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
      tree = renderer.create(<SettingsScreen />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  function testPrintButton(tree: renderer.ReactTestRenderer) {
    return tree.root.find(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes('Test Print') &&
        !elementText(node.props.children).includes('try Test Print'),
    );
  }

  async function releasePrints() {
    await renderer.act(async () => {
      pendingPrints.splice(0).forEach(resolve => resolve({success: true}));
    });
    await flush();
  }

  it('swaps the label for a spinner while the print is in flight', async () => {
    const tree = await mountScreen();
    expect(renderedText(tree.toJSON())).toContain('Test Print');

    const button = testPrintButton(tree);
    await renderer.act(async () => {
      button.props.onPress();
    });

    // While the print is still pending the label must be gone, replaced by the spinner.
    expect(renderedText(tree.toJSON())).not.toContain('Test Print');

    await releasePrints();
  });

  it('a second tap in the same frame does not print a second test receipt', async () => {
    const tree = await mountScreen();
    const button = testPrintButton(tree);

    // Two taps with no render between them, which is exactly what a double-tap delivers.
    await renderer.act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    await releasePrints();

    expect(mockPrintBuiltInJob).toHaveBeenCalledTimes(1);
  });
});
