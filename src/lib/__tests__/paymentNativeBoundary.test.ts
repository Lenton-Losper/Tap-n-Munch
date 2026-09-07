/**
 * THE REAL processPaymentIntent, WITH ONLY THE NATIVE MODULE FAKED.
 *
 * ==================================================================================================
 * WHY THIS SUITE EXISTS
 * ==================================================================================================
 *
 * On 2026-09-07 the first real tap of split card at Digi Cofee failed, and every test was green.
 *
 * The cause: `processPaymentIntent(amount, orderId)` takes an ORDER UUID as its second argument and
 * mints its own reference from prepare-payment. The split path passed the INTENT's
 * merchant_order_no there. resolvePrepareOrderId requires a UUID, so it threw before the reader was
 * ever launched -- three intents on production, resolved in 0.68s, 0.71s and 0.66s. The throw
 * carried no native code, defaulted to 'confirmed_failure', and a waiter was told the card had been
 * declined by a machine that never opened.
 *
 * NO TEST COULD SEE IT, because every suite mocked `../../lib/payment` wholesale.
 * processPaymentIntent was a jest.fn() returning whatever the test author wrote, so the test
 * asserted it was called with 'FT-SPLIT-ABC' and passed -- while the real function throws on that
 * exact input. The mock agreed with the caller because the same person wrote both.
 *
 * So this suite mocks ONLY the things that genuinely cannot exist in jest:
 *
 *   NativeModules.PaymentModule   an Android activity and a card reader
 *   the API client                HTTP
 *   storage                       the keystore
 *
 * Everything else -- resolvePrepareOrderId, the reference decision, the cents conversion, the
 * timeout race, the outcome classification -- is the REAL implementation. That is the layer the
 * defect lived in, and the only layer that can prove the argument contract holds.
 *
 * WHAT IT STILL CANNOT PROVE is listed at the bottom of this file. It is not nothing, and pretending
 * otherwise is how the last two builds shipped.
 */
jest.setTimeout(20000);

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

type Call = unknown[];

type Harness = {
  result: import('../payment').PaymentResult;
  launches: Call[];
  prepares: Call[];
  attemptStarted: Call[];
};

/**
 * Load payment.ts for real, with ONLY the native module and the network faked.
 *
 * Follows the pattern the orphan suites established: isolateModulesAsync, Platform.OS forced to
 * android (the RN preset defaults to ios, and processPaymentIntent early-returns "not available on
 * this platform" otherwise -- which would make every assertion below pass vacuously), and
 * NativeModules assigned by hand. RuntimeConfig must be set or api.ts throws at import.
 */
async function run(
  amount: number,
  orderId: string,
  options: import('../payment').PaymentReferenceOptions | undefined,
  native: {resolve?: Record<string, unknown>; reject?: {code?: string; message: string}},
  opts: {preparedRef?: string} = {},
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
    // Key-aware: a blanket answer also satisfies the TERMINAL TOKEN read, and a null token makes
    // processPaymentIntent early-return before the code under test.
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : null,
    );

    const launches: Call[] = [];
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      consumeOrphanedResult: jest.fn(async () => null),
      readWiretap: jest.fn(async () => []),
      clearWiretap: jest.fn(async () => undefined),
      recordWiretap: jest.fn(async () => undefined),
      launchPayment: jest.fn(async (...args: Call) => {
        launches.push(args);
        if (native.reject) {
          throw Object.assign(new Error(native.reject.message), {code: native.reject.code});
        }
        return native.resolve ?? {};
      }),
    };

    const prepares: Call[] = [];
    const attemptStarted: Call[] = [];
    const api = require('../api');
    jest.spyOn(api, 'prepareTerminalPayment').mockImplementation(async (...a: Call) => {
      prepares.push(a);
      return {
        orderId: String(a[0]),
        merchantOrderNo: opts.preparedRef ?? 'FT-FROM-PREPARE',
        created: true,
      };
    });
    jest
      .spyOn(api, 'markTerminalPaymentAttemptStarted')
      .mockImplementation(async (...a: Call) => {
        attemptStarted.push(a);
        return {ok: true} as never;
      });

    const {processPaymentIntent} = require('../payment');
    const result = await processPaymentIntent(amount, orderId, options);
    out = {result, launches, prepares, attemptStarted};
  });
  return out;
}

/** The success shape native returns for a completed SALE. */
const OK = (ref: string) => ({
  resultCode: '00',
  voucherNo: 'V123',
  businessOrderNo: ref,
  transactionId: 'TX1',
});

const ORDER_UUID = '11111111-1111-4111-8111-111111111111';
const SPLIT_REF = 'FT17887493094212018';

describe('THE DEFECT THAT SHIPPED — a caller-supplied reference', () => {
  it("REGRESSION: a non-UUID second argument with no options never reaches the reader", async () => {
    /**
     * Exactly what the split path did. Pinned as the failing shape so nobody reintroduces it by
     * "simplifying" the options object away.
     */
    const h = await run(6, SPLIT_REF, undefined, {resolve: OK(SPLIT_REF)});
    expect(h.launches).toHaveLength(0);
    expect(h.result.success).toBe(false);
    // And it must NOT claim a decline for a reader that never opened.
    expect(h.result.outcomeKind).toBe('not_started');
  });

  it('a supplied merchantOrderNo reaches the reader verbatim', async () => {
    const h = await run(6, ORDER_UUID, {merchantOrderNo: SPLIT_REF}, {resolve: OK(SPLIT_REF)});
    expect(h.launches).toHaveLength(1);
    const [amountCents, , merchantOrderNo] = h.launches[0] as [string, string, string];
    expect(merchantOrderNo).toBe(SPLIT_REF);
    expect(amountCents).toBe('600');
    expect(h.result.success).toBe(true);
  });

  it('and prepare-payment is NOT called, so the order reference is never reused', async () => {
    /**
     * THE POINT OF THE WHOLE INTENTS TABLE. orders.paycloud_merchant_order_no is one value per
     * order, minted once and never rotated. If prepare-payment ran here, two people paying for
     * their own items on one order would charge under the SAME reference and the webhook could not
     * tell their settlements apart.
     */
    const h = await run(6, ORDER_UUID, {merchantOrderNo: SPLIT_REF}, {resolve: OK(SPLIT_REF)});
    expect(h.prepares).toHaveLength(0);
  });

  it('a whole-order charge still mints its reference from prepare-payment', async () => {
    // The positive control. Without it, "prepare is not called" is satisfied by never calling it
    // at all, which would break every ordinary card payment.
    const h = await run(34, ORDER_UUID, undefined, {resolve: OK('FT-FROM-PREPARE')});
    expect(h.prepares).toHaveLength(1);
    const [, , merchantOrderNo] = h.launches[0] as [string, string, string];
    expect(merchantOrderNo).toBe('FT-FROM-PREPARE');
  });

  it('a split charge does not stamp the order card-in-flight', async () => {
    /**
     * markTerminalPaymentAttemptStarted stamps orders.terminal_pushed_at, the card-in-flight
     * marker, which blocks CASH on every OTHER item of that order for the timeout. A split charge
     * holds only the allocations it named, on its own intent.
     */
    const split = await run(6, ORDER_UUID, {merchantOrderNo: SPLIT_REF}, {resolve: OK(SPLIT_REF)});
    expect(split.attemptStarted).toHaveLength(0);

    const whole = await run(34, ORDER_UUID, undefined, {resolve: OK('FT-FROM-PREPARE')});
    expect(whole.attemptStarted).toHaveLength(1);
  });
});

describe('WHAT THE READER IS ASKED FOR — tip vs no tip', () => {
  it('whole-tab, NO tip: the reader is asked for the bill', async () => {
    const h = await run(34, ORDER_UUID, undefined, {resolve: OK('FT-FROM-PREPARE')});
    expect((h.launches[0] as string[])[0]).toBe('3400');
  });

  it('whole-tab, WITH tip: the reader is asked for bill PLUS tip, as one figure', async () => {
    /**
     * The under-charge this replaced: every call site passed bill-only amounts while the tip was
     * recorded server-side as collected. The customer paid the bill; the ledger claimed a gratuity.
     * The reader takes ONE number, so the caller adds the tip in and declares how much of it was
     * the tip.
     */
    const h = await run(34 + 5, ORDER_UUID, {tipAmount: 5}, {resolve: OK('FT-FROM-PREPARE')});
    expect((h.launches[0] as string[])[0]).toBe('3900');
  });

  it('split/item, NO tip: items only, under the intent reference', async () => {
    const h = await run(6, ORDER_UUID, {merchantOrderNo: SPLIT_REF}, {resolve: OK(SPLIT_REF)});
    const [amountCents, , ref] = h.launches[0] as [string, string, string];
    expect(amountCents).toBe('600');
    expect(ref).toBe(SPLIT_REF);
  });

  it('split/item, WITH tip: items plus tip, under the intent reference', async () => {
    const h = await run(
      6 + 2,
      ORDER_UUID,
      {merchantOrderNo: SPLIT_REF, tipAmount: 2},
      {resolve: OK(SPLIT_REF)},
    );
    const [amountCents, , ref] = h.launches[0] as [string, string, string];
    expect(amountCents).toBe('800');
    expect(ref).toBe(SPLIT_REF);
  });

  it('cents conversion rounds rather than truncating', async () => {
    // 12.345 must not silently become 1234. This is money.
    const h = await run(12.345, ORDER_UUID, undefined, {resolve: OK('FT-FROM-PREPARE')});
    expect((h.launches[0] as string[])[0]).toBe('1235');
  });
});

describe('EVERY NATIVE REJECT CODE, classified deliberately', () => {
  /**
   * The codes PaymentModule.kt raises before or instead of startActivityForResult. A separate
   * static test asserts this list stays complete against the Kotlin source; this one asserts what
   * each one BECOMES.
   */
  const PRE_READER = [
    'NO_ACTIVITY',
    'INTENT_ERROR',
    'MISSING_MERCHANT_ORDER_NO',
    'INVALID_MERCHANT_ORDER_NO',
  ];

  for (const code of PRE_READER) {
    it(`${code} is 'not_started' — never a decline`, async () => {
      const h = await run(34, ORDER_UUID, undefined, {
        reject: {code, message: 'launch failed'},
      });
      expect({code, kind: h.result.outcomeKind}).toEqual({code, kind: 'not_started'});
    });
  }

  it('WISECASHIER LAUNCH FAILURE: nothing is reported as charged', async () => {
    const h = await run(34, ORDER_UUID, undefined, {
      reject: {code: 'INTENT_ERROR', message: 'No Activity found to handle Intent'},
    });
    expect(h.result.success).toBe(false);
    expect(h.result.outcomeKind).toBe('not_started');
  });

  it('USER CANCELLATION is a cancel — not a decline, not a launch failure', async () => {
    const h = await run(34, ORDER_UUID, undefined, {
      reject: {code: 'PAYMENT_CANCELLED_BY_USER', message: 'Payment cancelled on the reader'},
    });
    expect(h.result.outcomeKind).toBe('user_cancelled');
  });

  it('PAYMENT_AMBIGUOUS stays ambiguous — it must reach a Finatic verify', async () => {
    const h = await run(34, ORDER_UUID, undefined, {
      reject: {code: 'PAYMENT_AMBIGUOUS', message: 'outcome unconfirmed'},
    });
    expect(h.result.outcomeKind).toBe('ambiguous');
  });

  it('A GENUINE GATEWAY DECLINE stays a confirmed failure, and keeps its gateway code', async () => {
    /**
     * THE POSITIVE CONTROL for the whole classification. If everything became 'not_started', every
     * assertion above would pass while real declines stopped being reported as declines -- and a
     * customer whose card was actually refused would be told the terminal was broken.
     */
    const h = await run(34, ORDER_UUID, undefined, {
      reject: {code: 'PAYMENT_DECLINED', message: 'PAYMENT_DECLINED (gateway result=N003)'},
    });
    expect(h.result.outcomeKind).toBe('confirmed_failure');
    expect(h.result.gatewayResult).toBe('N003');
  });

  it('a JS-side throw with NO native code is also not a decline', async () => {
    // resolvePrepareOrderId's UUID check is exactly this shape, and it is what shipped.
    const h = await run(6, 'not-a-uuid', undefined, {resolve: OK('x')});
    expect(h.result.outcomeKind).toBe('not_started');
  });
});

describe('what this suite CANNOT prove', () => {
  it('is written down rather than left to be inferred from silence', () => {
    /**
     * Everything here needs a real terminal. Listed so the gap is read, not assumed:
     *
     *   1. That WiseCashier accepts our Intent extras at all -- action, appId, transData shape.
     *      launchPayment is faked here, so a malformed Intent is invisible.
     *   2. That a 19-character FT reference is one Finatic accepts. E04111 "Merchant order number
     *      is invalid" was returned on production 2026-09-07 and is NOT explained by this code.
     *   3. That the amount survives native's %012d padding into the right minor units.
     *   4. That the BANK authorises bill+tip, rather than us merely asking for it.
     *   5. Which native code a real launch failure raises on a P5 -- the wiretap
     *      (launchPayment.error) carries it and nothing here can read a device.
     */
    const REQUIRES_A_REAL_TERMINAL = [
      'WiseCashier accepts the Intent extras',
      'Finatic accepts a 19-char FT reference (E04111 unexplained)',
      'minor-unit padding agrees with the currency',
      'the bank authorises bill+tip',
      'which native code a real launch failure raises',
    ];
    expect(REQUIRES_A_REAL_TERMINAL).toHaveLength(5);
  });
});
