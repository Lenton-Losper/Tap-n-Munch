/**
 * #101 — Diagnostics -> "PrintManager test receipt (system UI)" must not fire twice on a
 * double-tap.
 *
 * `handleSystemPrintTest` guarded re-entry with `disabled={systemPrintRunning}` only. State and
 * `disabled` are both a render behind, so two taps in the same frame both see
 * `systemPrintRunning === false` and both reach printSystemTestReceipt() ->
 * PrintFrameworkModule.printSystemTestReceipt, a native entry that puts ink on paper. Same
 * defect and same fix as Reprint Receipt (175d75e) and the two Test Print buttons (b5a3586):
 * a ref that flips synchronously.
 *
 * This is a printing action, not a money one. It sends a framework test page; it touches no
 * order, payment or settlement.
 *
 * The assertion counts calls that reached the native entry, not renders — a spinner appearing
 * would not have caught this, because the spinner already worked.
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

// The screen also reads NativeModules.RuntimeConfig directly to render the env block, which
// is absent under jest — there is no native build here.
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.RuntimeConfig = {
    ENV_NAME: 'staging',
    API_BASE_URL: 'https://example.invalid',
  };
  return RN;
});

// src/constants throws at module scope without a native RuntimeConfig. ENV_NAME must be
// 'staging': the whole section holding this button is gated on it (DiagnosticsScreen:418).
jest.mock('../../constants', () => ({
  APP_VERSION: '1.79',
  ENV_NAME: 'staging',
  FLASHTAP_API_URL: 'https://example.invalid',
}));

/** Resolvers for every system print currently held open, so a second entry is visible. */
let pendingPrints: Array<(v: unknown) => void> = [];
const mockPrintSystemTestReceipt = jest.fn(
  () =>
    new Promise<unknown>(resolve => {
      pendingPrints.push(resolve);
    }),
);

jest.mock('../../lib/printFramework', () => ({
  listSystemPrintServices: jest.fn(async () => ({
    sdkInt: 30,
    model: 'P5',
    manufacturer: 'Wiseasy',
    enabledServices: [],
    allServices: [],
    enabledCount: 0,
    allCount: 0,
    bipsEnabled: false,
    bipsPresentInAll: false,
    silentPrintSupportedByFramework: 'no',
    summary: 'none',
  })),
  printSystemTestReceipt: () => mockPrintSystemTestReceipt(),
}));

jest.mock('../../lib/api', () => ({
  getPrinterConfig: jest.fn(async () => null),
}));
jest.mock('../../lib/printer', () => ({
  getPrinterStatus: jest.fn(async () => ({connected: false, id: null})),
  runBluetoothPrintJob: jest.fn(async () => ({success: true})),
}));
jest.mock('../../lib/receiptPrintSettings', () => ({
  describeReceiptPrintError: () => 'Printing failed',
  getLastPrintResult: jest.fn(async () => null),
  getReceiptPrintingEnabled: jest.fn(async () => false),
  recordLastPrintResult: jest.fn(async () => undefined),
  setReceiptPrintingEnabled: jest.fn(async () => undefined),
}));
jest.mock('../../lib/storage', () => ({
  getRestaurantId: jest.fn(async () => 'restaurant-1'),
  getTerminalId: jest.fn(async () => 'terminal-1'),
  getTerminalToken: jest.fn(async () => 'token'),
}));
jest.mock('../../lib/testPrintPayload', () => ({
  buildSdk6TestPrintLines: () => [],
  buildTestPrintPayload: () => '',
}));
jest.mock('../../lib/wiseSdk6Printer', () => ({
  ACTIVE_PRINTER_TRANSPORT: 'WiseSdk4PrinterModule',
  getBuiltInPrinterStatus: jest.fn(async () => ({
    connected: true,
    hasPaper: true,
  })),
  printBuiltInJob: jest.fn(async () => ({success: true})),
  probeUsdkAidlService: jest.fn(async () => ({})),
  enumeratePrinterRelatedServices: jest.fn(async () => ({})),
  testRealInitPosSdk: jest.fn(async () => ({})),
  // The screen renders usdkProbe.components.length once this resolves, so it needs the shape.
  probeUsdkService: jest.fn(async () => ({
    action: 'probe',
    matchCount: 0,
    model: 'P5',
    sdkInt: 30,
    summary: 'none',
    components: [],
  })),
  getLastPrintSteps: jest.fn(async () => ({steps: []})),
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

import DiagnosticsScreen from '../DiagnosticsScreen';

/** Text of a React element subtree, used to locate a button by its label. */
function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  const props = (node as {props?: {children?: unknown}}).props;
  return props ? elementText(props.children) : '';
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

describe('#101 System Print Test in-flight feedback', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    mockPrintSystemTestReceipt.mockClear();
    pendingPrints = [];
    // The screen GETs /api/debug/runtime on mount; keep it off the network and out of the
    // unhandled-rejection log. Nothing here asserts on it.
    (globalThis as {fetch?: unknown}).fetch = jest.fn(() =>
      Promise.reject(new Error('offline in test')),
    );
  });

  afterEach(async () => {
    // Nothing may stay in flight across tests: an abandoned print would land its call during
    // the NEXT test, after that test's mockClear(), and inflate its count.
    await renderer.act(async () => {
      pendingPrints.splice(0).forEach(resolve => resolve({outcome: 'ok'}));
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
      // onClose is required but only fires from the back control, which nothing here taps.
      tree = renderer.create(<DiagnosticsScreen onClose={() => {}} />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  function systemPrintButton(tree: renderer.ReactTestRenderer) {
    return tree.root.find(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes('PrintManager test receipt'),
    );
  }

  async function releasePrints() {
    await renderer.act(async () => {
      pendingPrints.splice(0).forEach(resolve => resolve({outcome: 'ok'}));
    });
    await flush();
  }

  it('a second tap in the same frame does not send a second system print', async () => {
    const tree = await mountScreen();
    const button = systemPrintButton(tree);

    // Two taps with no render between them, which is exactly what a double-tap delivers.
    await renderer.act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    await releasePrints();

    expect(mockPrintSystemTestReceipt).toHaveBeenCalledTimes(1);
  });
});
