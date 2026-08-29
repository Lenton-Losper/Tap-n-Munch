/**
 * #164 — the "Printer service resolution" section must name the transport actually in use.
 *
 * These assertions run against the RENDERED screen, not the source, because the defect is
 * about what a technician reads off a terminal while holding it. Before the fix the section
 * named `WisePosSdk.initPosSdk` and the USDK action on every build, including the SDK4 builds
 * our P5 units actually run.
 */
import {PROBED_ACTION} from '../../lib/printerResolutionCopy';

// Native-backed storage the screen pulls in transitively. Nothing here asserts on it.
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

// DiagnosticsScreen now transitively imports lib/supabase.ts (via realtimeInvalidation.ts, for
// the temporary Realtime diagnostic section), which calls createClient(SUPABASE_URL, ...) at
// MODULE LOAD TIME -- this test's env has no real Supabase URL, so that throws before the screen
// ever renders. Mocked here, not by supplying a fake URL, since this suite has nothing to do with
// Realtime and the mock is the more direct statement of that.
jest.mock('../../lib/realtimeInvalidation', () => ({
  getRealtimeDiagnostics: () => ({
    status: 'idle',
    lastRawStatus: null,
    restaurantId: null,
    lastInvalidationAt: null,
  }),
  subscribeRealtimeDiagnostics: () => () => {},
}));

// Budget covers a MEASURED cold react-native module-graph transform (24-38s here depending on
// machine load), not slow logic — mounting a screen pays that fixed cost on the first render.
// Do not tighten it: at 30000 this suite passed or failed purely on how busy the box was.
jest.setTimeout(120000);

// The screen fetches /api/debug/runtime on mount. Nothing here asserts on it; keep it from
// making a real request and from leaving an unhandled rejection behind.
beforeEach(() => {
  (globalThis as {fetch?: unknown}).fetch = jest.fn(() =>
    Promise.reject(new Error('offline in test')),
  );
});

/** Collects every string the tree renders, so assertions read the artefact, not the source. */
function renderedText(json: unknown): string[] {
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
  return out;
}

/**
 * Mounts Diagnostics with the given transport and probe result, and returns everything it
 * rendered as text.
 *
 * ACTIVE_PRINTER_TRANSPORT is a module-level const derived from NativeModules, so the transport
 * is chosen by deciding which native module exists before the screen is first required. React
 * and the test renderer are required INSIDE the isolated registry as well — pulling them from
 * the outer one puts two copies of React in play and every hook call throws.
 *
 * BOTH SHAPES ARE RETURNED BECAUSE BOTH ARE NEEDED. `text` is right for "does this long sentence
 * appear". `lines` — one entry per rendered string, in tree order — is the only safe way to assert
 * a SHORT value like the transport name: `text.toContain('sdk4')` passes on any build, because
 * 'sdk4' is a substring of `wangpos.sdk4.base.service.BinderPoolService`, which the section
 * alongside it renders regardless. The #163 assertions below pin the value to its own label.
 */
async function renderDiagnosticsWith(opts: {
  transport: 'sdk4' | 'sdk6';
  matchCount: number;
}): Promise<{text: string; lines: string[]}> {
  let texts: string[] = [];
  await jest.isolateModulesAsync(async () => {
    const React = require('react');
    const renderer = require('react-test-renderer');
    const {NativeModules, Platform} = require('react-native');

    // Every native path in wiseSdk6Printer is gated on Platform.OS === 'android'; the RN jest
    // preset reports 'ios', which would make the probe return "unavailable" and never exercise
    // the copy under test.
    Platform.OS = 'android';

    // src/constants throws at import time without this, and the screen reads it directly.
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      ENV_NAME: 'test',
      GIT_SHA: 'testsha',
    };

    const action = PROBED_ACTION[opts.transport];
    const nativeModule = {
      isAvailable: async () => true,
      getStatus: async () => ({connected: true, hasPaper: true}),
      printJob: async () => true,
      probeService: async () => ({
        action,
        matchCount: opts.matchCount,
        model: 'P5',
        sdkInt: 30,
        summary: 'probe summary',
        components: [],
      }),
    };
    NativeModules.WiseSdk4PrinterModule =
      opts.transport === 'sdk4' ? nativeModule : undefined;
    NativeModules.WiseSdk6PrinterModule =
      opts.transport === 'sdk6' ? nativeModule : undefined;

    const DiagnosticsScreen = require('../DiagnosticsScreen').default;
    let tree: {toJSON: () => unknown};
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(DiagnosticsScreen, {onClose: () => {}}));
    });
    // Let the on-mount probe resolve and re-render before reading the tree.
    await renderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    texts = renderedText(tree!.toJSON());
  });
  return {text: texts.join('\n'), lines: texts};
}

/**
 * The value rendered immediately after `label`, or null when the label is absent.
 *
 * ADJACENCY IS THE ASSERTION. renderedText walks the tree depth-first, so a `<Text>label</Text>`
 * followed by a `<Text>{value}</Text>` lands as two consecutive entries. Checking the pair means
 * a stray occurrence of the value elsewhere on a very busy screen cannot satisfy the test — which
 * matters here, since what #162 and #163 both ask for is that a technician can READ THIS VALUE OFF
 * THIS ROW, not merely that the string exists somewhere in the tree.
 */
function valueAfterLabel(lines: string[], label: string): string | null {
  const i = lines.indexOf(label);
  return i < 0 || i + 1 >= lines.length ? null : lines[i + 1];
}

describe('#164 printer service resolution copy', () => {
  it('names the SDK4 binder-pool action, not initPosSdk, on an SDK4 build', async () => {
    const {text: rendered} = await renderDiagnosticsWith({transport: 'sdk4', matchCount: 1});

    expect(rendered).toContain(PROBED_ACTION.sdk4);
    expect(rendered).not.toContain('WisePosSdk.initPosSdk');
    expect(rendered).not.toContain(PROBED_ACTION.sdk6);
  });

  it('still names initPosSdk and the USDK action on an SDK6 build', async () => {
    const {text: rendered} = await renderDiagnosticsWith({transport: 'sdk6', matchCount: 1});

    expect(rendered).toContain('WisePosSdk.initPosSdk');
    expect(rendered).toContain(PROBED_ACTION.sdk6);
    expect(rendered).not.toContain(PROBED_ACTION.sdk4);
  });

  it('does not assert where the fault lies when resolution succeeds', async () => {
    const {text: rendered} = await renderDiagnosticsWith({transport: 'sdk4', matchCount: 1});

    // The probe establishes that the SDK can bind. It cannot establish that a fault exists,
    // let alone that it is elsewhere.
    expect(rendered).not.toContain('fault is elsewhere');
    expect(rendered).toContain('so the SDK can bind');
  });

  it('derives the zero-match verdict against the action actually probed', async () => {
    const {text: rendered} = await renderDiagnosticsWith({transport: 'sdk4', matchCount: 0});

    expect(rendered).toContain(
      `ZERO — nothing answers ${PROBED_ACTION.sdk4} for this app`,
    );
  });
});

/**
 * #163 — the Device / session rows must actually SHOW the values they exist to show.
 *
 * Both #162 and #163 are "a value is computed and nothing renders it" bugs, and both were fixed in
 * the screen but left unguarded. Measured before writing these: replacing
 * `{ACTIVE_PRINTER_TRANSPORT}` with a literal `{"unknown"}` — i.e. restoring #163 exactly — left
 * all 15 screen tests GREEN. The rule was covered; the row was not.
 *
 * That is the same gap #230 had on TablesScreen, and the same one the #344 wiring suite exists to
 * close on payment.ts. It is the defect this repo ships most often.
 */
describe('#163 / #162 — Device / session renders what a technician needs to read', () => {
  it('renders the ACTIVE transport on an SDK4 build', async () => {
    const {lines} = await renderDiagnosticsWith({transport: 'sdk4', matchCount: 1});

    // Adjacency, not substring: 'sdk4' also occurs inside the probed action string.
    expect(valueAfterLabel(lines, 'Printer transport')).toBe('sdk4');
  });

  it('renders the ACTIVE transport on an SDK6 build', async () => {
    // The other side. A row hardcoded to 'sdk4' would satisfy the assertion above.
    const {lines} = await renderDiagnosticsWith({transport: 'sdk6', matchCount: 1});

    expect(valueAfterLabel(lines, 'Printer transport')).toBe('sdk6');
  });

  it('renders the bridged build commit rather than "unknown" (#162)', async () => {
    const {lines} = await renderDiagnosticsWith({transport: 'sdk4', matchCount: 1});

    // #149's whole point: an installed build can name its own source. The value comes from
    // RuntimeConfig.GIT_SHA, which RuntimeConfigModule.getConstants() bridges from BuildConfig —
    // stubbed as 'testsha' above. Rendering 'unknown' here is the defect #162 reported.
    expect(valueAfterLabel(lines, 'Build commit')).toBe('testsha');
  });
});
