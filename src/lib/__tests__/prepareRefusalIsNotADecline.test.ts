/**
 * D-6 — a refusal from the SERVER, before the reader starts, is not a card decline.
 * D-4 — the raw gateway code reaches the failure report as its own field.
 *
 * ================================================================================================
 * D-6: WHY THESE CODES WERE THE ONES LEFT BEHIND
 * ================================================================================================
 *
 * `processPaymentIntent` learned about pre-reader failures after the Digi Cofee incident of
 * 2026-09-07, when a waiter was told a card had been declined by a reader that never opened. The
 * fix enumerated the four codes NATIVE raises before startActivityForResult.
 *
 * prepare-payment refuses from the other side of the wire. `prepareTerminalPayment` throws an
 * ApiRequestError carrying the SERVER's code, and because that code is truthy it cleared the
 * `if (!code)` guard, missed the native list, and inherited `confirmed_failure` — the same wrong
 * sentence, reached by a different road. No card was presented in any of these cases.
 *
 * ORDER_CANCELLED is the one that compounds with D-1: it is exactly the refusal a retry hits after
 * an order has been wrongly cancelled, so one defect creates the condition the other mislabels.
 *
 * ================================================================================================
 * AND WHY confirmed_failure IS NOW AN ALLOWLIST
 * ================================================================================================
 *
 * Enumerating codes fixes the five we know about and leaves the NEXT one broken. `confirmed_failure`
 * asserts the gateway looked at a card and refused it; only PAYMENT_DECLINED has ever earned that.
 * Everything unknown is now `ambiguous`, which means "ask Finatic before telling anyone this
 * failed" — the safe direction, and the one that needs no future maintenance.
 */

/** Marks this file as a MODULE. Without an import or export a test file lands in the GLOBAL
 *  scope, where its top-level `Call`/`Harness`/`ORDER_ID` collide with the identically named
 *  declarations in paymentNativeBoundary.test.ts — jest runs each file in its own registry and
 *  never notices, but tsc fails the whole project. */
export {};

type Reject = {code?: string; message: string};

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

type Harness = {
  outcomeKind?: string;
  error?: string;
  gatewayResult?: string;
  launched: boolean;
};

/**
 * Real payment.ts. `prepareTerminalPayment` is made to throw the way the API layer throws — an
 * Error carrying a `code` property, exactly as parseApiError builds it — and the native module
 * records whether the reader was ever launched.
 */
async function run(
  prepareRejects: Reject | null,
  nativeRejects: Reject | null = null,
): Promise<Harness> {
  let out!: Harness;
  await jest.isolateModulesAsync(async () => {
    const {NativeModules, Platform} = require('react-native');
    Platform.OS = 'android';
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };

    const encrypted = require('react-native-encrypted-storage').default as {
      getItem: jest.Mock;
    };
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : null,
    );

    let launched = false;
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      consumeOrphanedResult: jest.fn(async () => null),
      readWiretap: jest.fn(async () => []),
      clearWiretap: jest.fn(async () => undefined),
      recordWiretap: jest.fn(async () => undefined),
      launchPayment: jest.fn(async () => {
        launched = true;
        if (nativeRejects) {
          throw Object.assign(new Error(nativeRejects.message), {
            code: nativeRejects.code,
          });
        }
        return {voucherNo: 'VCHR-1', businessOrderNo: 'FT-1'};
      }),
    };

    const api = require('../api');
    jest.spyOn(api, 'prepareTerminalPayment').mockImplementation(async () => {
      if (prepareRejects) {
        // parseApiError builds exactly this shape: message + a `code` string off the JSON body.
        throw Object.assign(new Error(prepareRejects.message), {
          code: prepareRejects.code,
        });
      }
      return {orderId: ORDER_ID, merchantOrderNo: 'FT-1', created: true};
    });
    jest
      .spyOn(api, 'markTerminalPaymentAttemptStarted')
      .mockImplementation(async () => ({ok: true}) as never);

    const {processPaymentIntent} = require('../payment');
    const result = await processPaymentIntent(34, ORDER_ID);
    out = {
      outcomeKind: result.outcomeKind,
      error: result.error,
      gatewayResult: result.gatewayResult,
      launched,
    };
  });
  return out;
}

/** Every code prepare-payment can refuse with, and the HTTP status it uses. */
const SERVER_PRE_READER_CODES: Array<[string, string]> = [
  ['ORDER_CANCELLED', 'Order is cancelled'],
  ['ALREADY_PAID', 'Order is already paid'],
  ['NOTHING_LEFT_TO_CHARGE', 'Those items have already been paid for.'],
  ['SETTLED_TOTAL_UNREADABLE', 'Could not read what has already been paid'],
  ['EXPECTATION_NOT_RECORDED', 'Could not prepare this payment. Try again.'],
];

describe('D-6 — server-origin refusals before the reader starts', () => {
  it.each(SERVER_PRE_READER_CODES)(
    '%s is not_started, never a decline',
    async (code, message) => {
      const h = await run({code, message});

      // The assertion that matters: a waiter must not be told a card was refused.
      expect({code, kind: h.outcomeKind}).toEqual({code, kind: 'not_started'});
      // And the reason it is true: nothing was ever presented.
      expect(h.launched).toBe(false);
    },
  );

  it('POSITIVE CONTROL: a real gateway decline is still confirmed_failure', async () => {
    /**
     * Without this, "everything became not_started" would satisfy every test above and the
     * classifier would have stopped distinguishing anything at all.
     */
    const h = await run(null, {
      code: 'PAYMENT_DECLINED',
      message: 'Card declined by gateway (gateway result=N003)',
    });

    expect(h.outcomeKind).toBe('confirmed_failure');
    expect(h.launched).toBe(true);
  });

  it('an UNKNOWN code is ambiguous — it goes to Finatic, it does not assert a decline', async () => {
    // The allowlist's whole purpose: the next code nobody has classified fails safe.
    const h = await run({code: 'SOME_FUTURE_SERVER_CODE', message: 'Something new'});

    expect(h.outcomeKind).toBe('ambiguous');
    expect(h.outcomeKind).not.toBe('confirmed_failure');
  });

  it('an unknown code raised AFTER the reader ran is also ambiguous, not a decline', async () => {
    const h = await run(null, {code: 'SOME_FUTURE_NATIVE_CODE', message: 'Something new'});

    expect(h.launched).toBe(true);
    expect(h.outcomeKind).toBe('ambiguous');
  });

  it('a throw with NO code still reads as not_started', async () => {
    // Unchanged behaviour, pinned so the allowlist did not quietly swallow this branch.
    const h = await run({message: 'prepare-payment did not return merchantOrderNo'});

    expect(h.outcomeKind).toBe('not_started');
  });
});

describe('D-4 — the gateway code survives the native boundary', () => {
  it('N002 is extracted from an ambiguous rejection', async () => {
    const h = await run(null, {
      code: 'PAYMENT_AMBIGUOUS',
      message: 'Payment result was not a confirmed success (gateway result=N002)',
    });

    expect(h.outcomeKind).toBe('ambiguous');
    expect(h.gatewayResult).toBe('N002');
  });

  it('N002 classification is UNCHANGED by any of this — still ambiguous, never a decline', async () => {
    /**
     * Pinned deliberately. These fixes must not alter what N002 means; that is open work awaiting
     * device evidence. Ambiguous is the safe default and it stays.
     */
    const h = await run(null, {
      code: 'PAYMENT_AMBIGUOUS',
      message: 'Payment result was not a confirmed success (gateway result=N002)',
    });

    expect(h.outcomeKind).not.toBe('confirmed_failure');
    expect(h.outcomeKind).not.toBe('not_started');
    expect(h.outcomeKind).toBe('ambiguous');
  });

  it('a structured userInfo code is preferred over the message suffix when present', async () => {
    /**
     * Native now also attaches the code as userInfo.gatewayResult. The message suffix stays as the
     * floor — a JS bundle can outlive its APK — so this proves the structured value WINS where it
     * arrives, using a deliberately different value in each place.
     */
    let out!: string | undefined;
    await jest.isolateModulesAsync(async () => {
      const {NativeModules, Platform} = require('react-native');
      Platform.OS = 'android';
      NativeModules.RuntimeConfig = {
        API_BASE_URL: 'https://example.invalid',
        SUPABASE_URL: 'https://example.invalid',
        SUPABASE_ANON_KEY: 'test',
        ENV_NAME: 'test',
      };
      const encrypted = require('react-native-encrypted-storage').default as {
        getItem: jest.Mock;
      };
      encrypted.getItem.mockImplementation(async (key: string) =>
        key === 'flashtap_terminal_token' ? 'test-token' : null,
      );
      NativeModules.PaymentModule = {
        launchRefund: jest.fn(),
        consumeOrphanedResult: jest.fn(async () => null),
        readWiretap: jest.fn(async () => []),
        clearWiretap: jest.fn(async () => undefined),
        recordWiretap: jest.fn(async () => undefined),
        launchPayment: jest.fn(async () => {
          throw Object.assign(
            new Error('Payment result was not a confirmed success (gateway result=FROM_MESSAGE)'),
            {code: 'PAYMENT_AMBIGUOUS', userInfo: {gatewayResult: 'FROM_USERINFO'}},
          );
        }),
      };
      const api = require('../api');
      jest
        .spyOn(api, 'prepareTerminalPayment')
        .mockImplementation(async () => ({
          orderId: ORDER_ID,
          merchantOrderNo: 'FT-1',
          created: true,
        }));
      jest
        .spyOn(api, 'markTerminalPaymentAttemptStarted')
        .mockImplementation(async () => ({ok: true}) as never);

      const {processPaymentIntent} = require('../payment');
      out = (await processPaymentIntent(34, ORDER_ID)).gatewayResult;
    });

    expect(out).toBe('FROM_USERINFO');
  });

  it('falls back to the message suffix when native sends no userInfo (older APK)', async () => {
    const h = await run(null, {
      code: 'PAYMENT_AMBIGUOUS',
      message: 'Payment result was not a confirmed success (gateway result=N002)',
    });

    expect(h.gatewayResult).toBe('N002');
  });
});

/**
 * D-4 — THE SCREENS ACTUALLY PASS THE CODE.
 *
 * ================================================================================================
 * WHY THIS IS A SOURCE ASSERTION AND NOT A BEHAVIOURAL ONE
 * ================================================================================================
 *
 * The wire test in apiPaymentContract proves completePayment serialises `gatewayResult` when it is
 * given one. It CANNOT prove anyone gives it one — `body: JSON.stringify(payload)` sends whatever
 * the caller passed, so deleting the field from the payload TYPE changes nothing at runtime and
 * that mutation goes green. Measured 2026-09-16: 91/91 still passed with the type field removed.
 *
 * The runtime gap is therefore the CALL SITES, and both of them live inside long screen components
 * behind a device payment, a Finatic verify and a settle. Rendering that to assert one request
 * field would test the mock harness more than the wiring.
 *
 * So this reads the two sources, the same technique paymentNativeCodeCoverage already uses against
 * the Kotlin. It has the controls that technique needs: it proves the files were read, proves the
 * extractor finds the call sites at all, and proves it can tell a call WITH the field from one
 * without — so it cannot pass by matching nothing.
 */
describe('D-4 — both failure-report call sites carry the gateway code', () => {
  const {readFileSync, existsSync} = require('fs') as {
    readFileSync: (p: string, e: string) => string;
    existsSync: (p: string) => boolean;
  };
  const {join} = require('path') as {join: (...p: string[]) => string};
  /**
   * From the REPO ROOT, not __dirname, which jest does not reliably provide here — the same
   * resolution paymentNativeCodeCoverage uses, and for the same reason. The readability assertion
   * below then fails with a path in the message rather than passing on a silent miss.
   */
  const proc = (globalThis as unknown as {process?: {cwd(): string}}).process;
  const screens = join(proc ? proc.cwd() : '.', 'src', 'screens');

  /** The `completePaymentReliably(...)` call that reports a FAILURE, as source text. */
  function failureReportCall(source: string): string | null {
    const at = source.indexOf('completePaymentReliably(');
    if (at === -1) return null;
    // Balance from the opening paren so a nested object literal cannot end the match early.
    let depth = 0;
    for (let i = source.indexOf('(', at); i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(at, i + 1);
      }
    }
    return null;
  }

  const FILES = ['PaymentScreen.tsx', 'TableDetailScreen.tsx'];

  it('the screen sources are readable — this suite is not passing on an empty read', () => {
    for (const f of FILES) {
      expect({file: f, found: existsSync(join(screens, f))}).toEqual({file: f, found: true});
    }
  });

  it('POSITIVE CONTROL: the extractor finds a real call, with its payload', () => {
    const call = failureReportCall(readFileSync(join(screens, 'PaymentScreen.tsx'), 'utf8'));
    expect(call).not.toBeNull();
    expect(call).toContain("status: 'failed'");
  });

  it('NEGATIVE CONTROL: it can tell a call that omits the field from one that carries it', () => {
    const without = "completePaymentReliably(id, token, {\n  status: 'failed',\n  reference: r,\n})";
    const withIt =
      "completePaymentReliably(id, token, {\n  status: 'failed',\n  ...(r.gatewayResult ? {gatewayResult: r.gatewayResult} : {}),\n})";
    expect(failureReportCall(without)).not.toContain('gatewayResult');
    expect(failureReportCall(withIt)).toContain('gatewayResult');
  });

  it.each(FILES)('%s passes gatewayResult on the failure report', file => {
    const call = failureReportCall(readFileSync(join(screens, file), 'utf8'));
    expect(call).not.toBeNull();
    // Without this the code is extracted, held in PaymentResult, shown to staff — and dropped at
    // the one boundary where it would have become a record.
    expect(call).toContain('gatewayResult');
  });
});
