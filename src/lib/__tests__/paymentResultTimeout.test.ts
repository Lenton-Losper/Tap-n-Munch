/**
 * #346 — THE PAYMENT PROMISE HAS A CEILING, AND CROSSING IT MUST NOT LOSE OR LIBEL THE PAYMENT.
 *
 * `launchPayment` had no timeout at all: if WiseCashier never returned, processPaymentIntent
 * awaited forever and the screen showed "PROCESSING / Please wait..." with no end. Adding a
 * timeout is easy; adding one that is not a NEW defect is the whole job, and these tests pin the
 * two ways it could be.
 *
 *   1. THE OUTCOME MUST BE AMBIGUOUS, NEVER A FAILURE. WiseCashier is a separate activity still
 *      holding the card. Telling the server the sale failed while the reader is charging it is
 *      strictly worse than waiting forever — the server would act on a statement that is false.
 *      'ambiguous' makes the server verify against Finatic, which is the correct response to not
 *      knowing.
 *
 *   2. THE LATE RESULT MUST BE KEPT. Promise.race does not cancel the loser. Without a handler the
 *      reader's answer resolves into nothing and a real card transaction disappears — the same
 *      class of loss as the destructive consume that #344 ruling 4 removed.
 *
 * Both assertions drive processPaymentIntent itself rather than a helper, for the reason
 * orphanPaymentWiring.test.ts states: a correct rule no call site uses is this project's
 * best-documented shape of defect.
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

const ORDER = '33333333-3333-4333-8333-333333333333';

type Held = {
  orphanOrderId: string;
  reason: string;
  voucherNo?: string;
  outcomeKind?: string;
};

type Outcome = {
  result: {
    success?: boolean;
    outcomeKind?: string;
    error?: string;
    voucherNo?: string;
  };
  held: Held[];
  /** The ceiling the run was measured against, read from the real constant, not restated here. */
  timeoutMs: number;
};

/**
 * Drive processPaymentIntent with a launchPayment that resolves LATE, or never.
 *
 * `lateResolveAfterMs: null` means it never resolves at all — the hang this timeout exists for.
 * Otherwise the reader answers after the timeout has already fired, which is the case where the
 * late-result handler is the only thing standing between a real transaction and oblivion.
 */
async function runWithSlowReader(opts: {
  lateResolveAfterMs: number | null;
  lateResult?: Record<string, unknown>;
}): Promise<Outcome> {
  let out!: Outcome;
  await jest.isolateModulesAsync(async () => {
    jest.useFakeTimers();
    try {
    const {NativeModules, Platform} = require('react-native');
    Platform.OS = 'android';
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };

    let stored: string | null = null;
    const encrypted = require('react-native-encrypted-storage').default as {
      getItem: jest.Mock;
      setItem: jest.Mock;
    };
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : stored,
    );
    encrypted.setItem.mockImplementation(async (_k: string, v: string) => {
      stored = v;
    });

    /**
     * prepare-payment MUST SUCCEED here, unlike the wiring suite where it is allowed to fail.
     * If it throws we never reach launchPromise and the timeout under test is never armed — the
     * assertions would then pass for the wrong reason, which is the failure mode this project
     * keeps finding. A merchant order number is returned so the ambiguous result can carry it.
     */
    (globalThis as unknown as {fetch: jest.Mock}).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      // `headers.get` is required, not decoration: without it the response parse throws, the
      // call lands in the catch, and processPaymentIntent never reaches launchPromise at all —
      // which presents as the test hanging rather than as a wrong assertion.
      headers: {get: () => 'application/json'},
      json: async () => ({
        orderId: ORDER,
        merchantOrderNo: 'FT-TIMEOUT-TEST',
        created: true,
      }),
      text: async () => '{}',
    })) as unknown as jest.Mock;

    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      launchPayment: jest.fn(
        () =>
          new Promise(resolve => {
            if (opts.lateResolveAfterMs !== null) {
              setTimeout(() => resolve(opts.lateResult ?? {}), opts.lateResolveAfterMs);
            }
            // else: never resolves. That is the hang.
          }),
      ),
      // No orphan waiting; this suite is about the CURRENT payment, not a recovered one.
      peekOrphanedPaymentResult: jest.fn(async () => null),
      consumeOrphanedPaymentResult: jest.fn(async () => null),
      clearOrphanedPaymentResult: jest.fn(async () => true),
    };

    const payment = require('../payment') as typeof import('../payment');
    const {PAYMENT_RESULT_TIMEOUT_MS} = require('../../constants') as {
      PAYMENT_RESULT_TIMEOUT_MS: number;
    };

    const pending = payment.processPaymentIntent(50, ORDER);

    /**
     * DRIVE THE CLOCK IN SMALL STEPS, FLUSHING MICROTASKS BETWEEN, rather than jumping straight
     * past the timeout.
     *
     * A single advanceTimersByTime here HANGS, and it hangs silently. prepare-payment's promise
     * chain has to settle before launchPromise exists, and the timeout timer is only created after
     * that — so a jump made too early advances past a timer that does not exist yet, and nothing
     * ever fires again. Counting `await Promise.resolve()` calls to get ahead of it is guessing at
     * an implementation detail; stepping until the promise actually settles is not.
     */
    /**
     * OBSERVE SETTLEMENT WITH A FLAG, NOT A RACE. `Promise.race([pending, Promise.resolve(m)])`
     * cannot work here: the already-resolved marker always wins the microtask, so the loop reports
     * "never settled" even when the promise settled on the first tick. Caught exactly that way.
     */
    let settledValue: Outcome['result'] | undefined;
    let didSettle = false;
    void pending.then(v => {
      settledValue = v as Outcome['result'];
      didSettle = true;
    });

    const flush = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    };

    const settle = async (label: string) => {
      for (let i = 0; i < 400; i++) {
        await flush();
        if (didSettle) {
          return settledValue as Outcome['result'];
        }
        jest.advanceTimersByTime(5_000);
      }
      throw new Error(
        `processPaymentIntent never settled while ${label} (advanced 2000s of fake time)`,
      );
    };

    const result = await settle('waiting for the timeout');

    /**
     * Now let the LATE result arrive. The handler is deliberately not awaited by the code under
     * test, so the only way to observe it is to keep the clock and the microtask queue moving.
     */
    for (let i = 0; i < 200; i++) {
      await flush();
      jest.advanceTimersByTime(5_000);
    }

      out = {
        result,
        held: stored ? (JSON.parse(stored) as Held[]) : [],
        timeoutMs: PAYMENT_RESULT_TIMEOUT_MS,
      };
    } finally {
      // Without the finally, one failing test leaves fake timers installed and every LATER test
      // fails with "isolateModulesAsync cannot be nested" — one real failure reported as four.
      jest.useRealTimers();
    }
  });
  return out;
}

describe('#346 — the reader never answers', () => {
  it('returns AMBIGUOUS, never a failure', async () => {
    const {result} = await runWithSlowReader({lateResolveAfterMs: null});

    // The safety property. A confirmed_failure here tells the server a sale did not happen while
    // the card may be being charged, and the server acts on it.
    expect(result.outcomeKind).toBe('ambiguous');
    expect(result.outcomeKind).not.toBe('confirmed_failure');
    expect(result.success).toBe(false);
  });

  it('says the card may still have been charged, and not to ring it up again', async () => {
    const {result} = await runWithSlowReader({lateResolveAfterMs: null});
    const message = String(result.error ?? '').toLowerCase();

    // These two facts are the reason the string exists; an edit that drops either is the defect.
    expect(message).toContain('may still have been charged');
    expect(message).toContain('do not ring this sale up again');
  });
});

describe('#346 — the reader answers AFTER we stopped waiting', () => {
  it('keeps the late result instead of dropping it', async () => {
    const {held} = await runWithSlowReader({
      // Answers a minute after the timeout fired. Promise.race abandoned it; the handler must not.
      lateResolveAfterMs: 360_000,
      lateResult: {
        outcome: 'success',
        voucherNo: 'V-LATE-4242',
        businessOrderNo: 'FT-TIMEOUT-TEST',
        orderId: ORDER,
      },
    });

    // Without the late handler this array is empty and a settled card payment is gone for good.
    expect(held).toHaveLength(1);
    expect(held[0].voucherNo).toBe('V-LATE-4242');
  });

  it('does not apply the late result to whatever the operator moved on to', async () => {
    const {held} = await runWithSlowReader({
      lateResolveAfterMs: 360_000,
      lateResult: {
        outcome: 'success',
        voucherNo: 'V-LATE-4242',
        businessOrderNo: 'FT-TIMEOUT-TEST',
        orderId: ORDER,
      },
    });

    // Nobody is waiting on that screen any more, so it is held for the reporting pass rather than
    // applied. Held at all is the first requirement; held rather than applied is the second.
    expect(held[0].reason).toBeDefined();
    expect(['different_order', 'unknown_order', 'non_success_not_applied']).toContain(
      held[0].reason,
    );
  });
});

describe('#346 — a SLOW payment that still succeeds', () => {
  it('is not timed out early, and comes back as a normal success', async () => {
    /**
     * THE OPPOSITE FAILURE, and it is the one that would cost money. A timeout set too tight
     * converts a working sale into an unconfirmed one. Production's slowest SUCCESSFUL payment is
     * 284s (Mingle #371), which is why the constant is 300s rather than anything derived from the
     * 156s re-ring figure — that number measures something else entirely.
     *
     * 100s is well past the 45s advisory ceiling, so the operator has been warned, and well inside
     * the hard timeout, so nothing is abandoned.
     */
    const {result, held, timeoutMs} = await runWithSlowReader({
      lateResolveAfterMs: 100_000,
      lateResult: {
        outcome: 'success',
        voucherNo: 'V-SLOW-100',
        businessOrderNo: 'FT-TIMEOUT-TEST',
        orderId: ORDER,
      },
    });

    // The premise of the test, asserted rather than assumed: 100s really is inside the ceiling.
    expect(timeoutMs).toBeGreaterThan(100_000);

    expect(result.outcomeKind).toBe('success');
    expect(result.success).toBe(true);
    expect(result.voucherNo).toBe('V-SLOW-100');
    // It settled normally, so there is nothing to hold.
    expect(held).toHaveLength(0);
  });
});

/**
 * #346 — THE TWO CEILINGS ARE TWO NUMBERS, AND COLLAPSING THEM IS THE PREDICTABLE EDIT.
 *
 * The issue is explicit that they must not be collapsed, and the constant's own docblock says so in
 * capitals — but nothing asserted it. PAYMENT_RESULT_TIMEOUT_MS was covered by the suite above;
 * PAYMENT_ADVISORY_CEILING_S was covered by nothing at all, which makes the number most likely to
 * be "tidied" the one with no guard.
 *
 * They answer different questions. The ADVISORY ceiling is when to tell a human something: 45s,
 * chosen because 98.2% of successful payments are done by then, so it neither cries wolf nor
 * arrives after staff have already given up (the measured median before staff re-rang was 42s).
 * The HARD timeout is when to stop waiting for the promise: 300s, which has to clear the slowest
 * payment that ever actually SUCCEEDED — 284s, Mingle #371.
 *
 * Setting the hard timeout to 45s would abandon real payments. Setting the advisory to 300s would
 * restore the silent screen this issue is about, five minutes of it.
 */
describe('#346 — the advisory ceiling and the hard timeout stay distinct', () => {
  const {
    PAYMENT_ADVISORY_CEILING_S,
    PAYMENT_RESULT_TIMEOUT_MS,
  } = require('../../constants') as {
    PAYMENT_ADVISORY_CEILING_S: number;
    PAYMENT_RESULT_TIMEOUT_MS: number;
  };

  it('keeps the advisory ceiling at the measured 45s', () => {
    expect(PAYMENT_ADVISORY_CEILING_S).toBe(45);
  });

  it('keeps the hard timeout long enough for the slowest payment that ever succeeded', () => {
    // 284s, Mingle #371. A timeout at or below that abandons a payment that would have landed.
    expect(PAYMENT_RESULT_TIMEOUT_MS).toBe(300_000);
    expect(PAYMENT_RESULT_TIMEOUT_MS).toBeGreaterThan(284_000);
  });

  it('does not let the advisory ceiling become the hard timeout', () => {
    // The collapse, in one assertion, in whichever direction it is attempted.
    expect(PAYMENT_ADVISORY_CEILING_S * 1000).not.toBe(PAYMENT_RESULT_TIMEOUT_MS);
    // And the advisory must fire FIRST, by a wide margin — it exists to warn while there is still
    // something to wait for.
    expect(PAYMENT_ADVISORY_CEILING_S * 1000).toBeLessThan(
      PAYMENT_RESULT_TIMEOUT_MS,
    );
  });

  it('states the ceiling to the operator in the waiting copy', () => {
    // The number is only useful if the operator is told it: "a bounded wait is a different
    // experience from an open one". This is what makes the constant load-bearing rather than
    // internal.
    const {paymentProcessingElapsed} =
      require('../../constants/paymentCopy') as {
        paymentProcessingElapsed: (e: number, c: number) => string;
      };
    const line = paymentProcessingElapsed(12, PAYMENT_ADVISORY_CEILING_S);
    expect(line).toContain('12s');
    expect(line).toContain(`${PAYMENT_ADVISORY_CEILING_S}s`);
    // Signed decision: ASCII hyphen, never an em dash — an em dash on a payment screen is the
    // concatenation shape #326 was.
    expect(line).not.toContain('—');
  });
});

export {};
