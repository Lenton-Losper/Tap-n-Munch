/**
 * PAYMENT TIMELINE MARKS -- where each mark lands in the REAL processPaymentIntent, relative to the
 * real HTTP calls and the native WiseCashier launch, and that recording them changes nothing.
 *
 * One ordered log interleaves: timeline marks (from the wiretap bridge), every fetch (by route), and
 * the native launchPayment call. That log IS the payment sequence this build performs, so the test
 * doubles as its specification -- including the fact that attempt-started is posted AFTER the
 * WiseCashier intent has launched, i.e. while WiseCashier is on screen.
 */
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

const ORDER = '44444444-4444-4444-8444-444444444444';

type Run = {
  log: string[];
  marks: Array<Record<string, unknown>>;
  result: {success?: boolean; outcomeKind?: string; prepareRefusal?: unknown};
};

async function run(opts: {
  prepareStatus?: number;
  native: 'resolve' | 'reject';
  wiretapThrows?: boolean;
}): Promise<Run> {
  let out!: Run;
  await jest.isolateModulesAsync(async () => {
    const {NativeModules, Platform} = require('react-native');
    Platform.OS = 'android';
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };
    const encrypted = require('react-native-encrypted-storage').default as {getItem: jest.Mock};
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : null,
    );

    const log: string[] = [];
    const marks: Array<Record<string, unknown>> = [];

    (globalThis as unknown as {fetch: jest.Mock}).fetch = jest.fn(async (url: string) => {
      const route = String(url).replace(/^.*\/api\/terminal\/orders\/[^/]+\//, '');
      log.push(`http:${route}`);
      const status = route === 'prepare-payment' ? opts.prepareStatus ?? 200 : 200;
      const body =
        route === 'prepare-payment'
          ? status === 200
            ? {orderId: ORDER, merchantOrderNo: 'FT-TIMELINE-1', created: true, chargeCents: 5000}
            : {error: 'nothing left', code: 'NOTHING_LEFT_TO_CHARGE'}
          : {recorded: true, startedAt: '2026-10-01T10:00:00Z'};
      return {
        ok: status < 400,
        status,
        headers: {get: () => 'application/json'},
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as unknown as jest.Mock;

    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      launchPayment: jest.fn(() => {
        log.push('native:launchPayment');
        return opts.native === 'resolve'
          ? Promise.resolve({
              success: true,
              voucherNo: 'TX-1',
              businessOrderNo: 'FT-TIMELINE-1',
              orderId: ORDER,
            })
          : Promise.reject(Object.assign(new Error('declined'), {code: 'PAYMENT_FAILED'}));
      }),
      recordWiretapEvent: jest.fn(async (event: string, json: string) => {
        if (opts.wiretapThrows) throw new Error('wiretap broken');
        if (event === 'payment.timeline') {
          const detail = JSON.parse(json) as Record<string, unknown>;
          marks.push(detail);
          log.push(`mark:${detail.mark}`);
        }
        return true;
      }),
      peekOrphanedPaymentResult: jest.fn(async () => null),
      consumeOrphanedPaymentResult: jest.fn(async () => null),
      clearOrphanedPaymentResult: jest.fn(async () => true),
    };

    /**
     * The code under test arms real timers it does not always clear (the 300 s result ceiling is
     * left running when the native promise REJECTS -- harmless on a device, but it holds jest's
     * process open for five minutes). Track this run's timers and clear them when it is done.
     */
    const realSetTimeout = globalThis.setTimeout;
    const armed: Array<ReturnType<typeof setTimeout>> = [];
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
      const id = realSetTimeout(fn, ms, ...a);
      armed.push(id);
      return id;
    }) as typeof setTimeout;
    try {
      const payment = require('../payment') as typeof import('../payment');
      const result = await payment.processPaymentIntent(50, ORDER);
      out = {log, marks, result: result as Run['result']};
    } finally {
      globalThis.setTimeout = realSetTimeout;
      for (const id of armed) clearTimeout(id);
    }
  });
  return out;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('a card success: the sequence this build performs, with every observable mark in place', async () => {
  const r = await run({native: 'resolve'});
  expect(r.result.success).toBe(true);
  expect(r.log).toEqual([
    'mark:t0_start',
    'http:prepare-payment', // BEFORE the reader: its latency is on the customer's clock
    'mark:prepare_done',
    'mark:launch_requested',
    'native:launchPayment', // T1: startActivityForResult -- WiseCashier takes the screen
    'http:attempt-started', // AFTER launch: runs while WiseCashier is on screen
    'mark:result_in_js', // T5 as JS sees it
  ]);
  expect(r.marks.find((m) => m.mark === 'result_in_js')).toMatchObject({settled: 'resolved'});
});

it('a non-success result (native rejects): result_in_js is still marked, once', async () => {
  const r = await run({native: 'reject'});
  expect(r.result.success).toBe(false);
  expect(r.log.filter((l) => l === 'mark:result_in_js')).toHaveLength(1);
  expect(r.log.indexOf('mark:result_in_js')).toBeGreaterThan(r.log.indexOf('native:launchPayment'));
  expect(r.marks.find((m) => m.mark === 'result_in_js')).toMatchObject({settled: 'rejected'});
});

it('prepare-payment refused: T0 only -- no launch, no result marked (WiseCashier never opened)', async () => {
  const r = await run({prepareStatus: 409, native: 'resolve'});
  expect(r.result.prepareRefusal).toBeTruthy();
  expect(r.log).toContain('mark:t0_start');
  expect(r.log).not.toContain('native:launchPayment');
  expect(r.log).not.toContain('mark:launch_requested');
  expect(r.log).not.toContain('mark:result_in_js');
});

it('a wiretap that throws cannot change the payment outcome', async () => {
  const healthy = await run({native: 'resolve'});
  const broken = await run({native: 'resolve', wiretapThrows: true});
  expect(broken.result).toEqual(healthy.result);
});

it('marks carry correlation ids and outcome classes only -- no amounts, tokens or card data', async () => {
  const r = await run({native: 'resolve'});
  const allowed = new Set(['mark', 'jsAt', 'orderId', 'businessOrderNo', 'prepared', 'suppliedRef', 'settled']);
  for (const m of r.marks) {
    for (const key of Object.keys(m)) expect(allowed.has(key)).toBe(true);
    expect(typeof m.jsAt).toBe('number');
  }
});
