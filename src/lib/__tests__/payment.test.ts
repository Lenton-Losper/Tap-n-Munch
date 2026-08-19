/**
 * #182 and #183 — both live in src/lib/payment.ts's failure-classification path.
 *
 * payment.ts reads NativeModules.PaymentModule at module load time and imports
 * APP_VERSION from ../constants, which throws at import time without
 * NativeModules.RuntimeConfig.API_BASE_URL set (see constants/index.ts). It also pulls in
 * ./api -> ./storage -> react-native-encrypted-storage transitively, which has no native
 * module in the test environment. So each test sets RuntimeConfig/PaymentModule up and
 * requires payment.ts fresh inside jest.isolateModulesAsync, matching the pattern already
 * used by src/screens/__tests__/diagnosticsPrinterResolution.test.tsx.
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

async function loadPaymentModule(opts: {
  consumeOrphanedPaymentResult?: () => Promise<unknown>;
}): Promise<typeof import('../payment')> {
  let mod!: typeof import('../payment');
  await jest.isolateModulesAsync(async () => {
    const {NativeModules} = require('react-native');
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };
    NativeModules.PaymentModule = {
      launchPayment: jest.fn(),
      launchRefund: jest.fn(),
      ...(opts.consumeOrphanedPaymentResult
        ? {consumeOrphanedPaymentResult: opts.consumeOrphanedPaymentResult}
        : {}),
    };
    mod = require('../payment');
  });
  return mod;
}

describe('extractGatewayResult (#182 regression guard)', () => {
  it('extracts the code from the pre-#182 generic message', async () => {
    const {extractGatewayResult} = await loadPaymentModule({});
    expect(
      extractGatewayResult(
        'Payment result was not a confirmed success (gateway result=K099)',
      ),
    ).toBe('K099');
  });

  it.each([
    ['K025', 'Need Sign In'],
    ['K029', 'Battery too low to trade. Please charge your device first.'],
    ['K030', 'The remote card reader is not connected!'],
    ['K031', 'Please settle first'],
    ['K032', 'Please load emv parameters'],
    ['K033', 'Key Not Injected'],
  ])(
    'still extracts %s from the #182 friendly message for it',
    async (code, friendlyText) => {
      const {extractGatewayResult} = await loadPaymentModule({});
      expect(
        extractGatewayResult(`${friendlyText} (gateway result=${code})`),
      ).toBe(code);
    },
  );

  it('returns undefined when the trailing suffix is missing entirely', async () => {
    const {extractGatewayResult} = await loadPaymentModule({});
    expect(extractGatewayResult('Some unrelated error')).toBeUndefined();
  });
});

describe('consumeOrphanedIfAny (#183)', () => {
  it('reports an orphaned user_cancelled outcome as user_cancelled, not ambiguous', async () => {
    const {consumeOrphanedIfAny} = await loadPaymentModule({
      consumeOrphanedPaymentResult: async () => ({
        outcome: 'user_cancelled',
        orphaned: true,
        gatewayResult: 'K026',
        businessOrderNo: 'FT123',
        voucherNo: '',
        error: '',
      }),
    });

    const result = await consumeOrphanedIfAny();

    expect(result?.success).toBe(false);
    expect(result?.outcomeKind).toBe('user_cancelled');
    expect(result?.orphaned).toBe(true);
    expect(result?.gatewayResult).toBe('K026');
    expect(result?.businessOrderNo).toBe('FT123');
  });

  it('still reports a genuinely unclassified orphan as orphaned_ambiguous', async () => {
    const {consumeOrphanedIfAny} = await loadPaymentModule({
      consumeOrphanedPaymentResult: async () => ({
        outcome: 'ambiguous',
        orphaned: true,
        voucherNo: '',
      }),
    });

    const result = await consumeOrphanedIfAny();

    expect(result?.outcomeKind).toBe('orphaned_ambiguous');
  });

  it('still reports an orphaned success as orphaned_success, unaffected by the new branch', async () => {
    const {consumeOrphanedIfAny} = await loadPaymentModule({
      consumeOrphanedPaymentResult: async () => ({
        outcome: 'success',
        orphaned: true,
        voucherNo: 'V123',
        businessOrderNo: 'FT456',
      }),
    });

    const result = await consumeOrphanedIfAny();

    expect(result?.success).toBe(true);
    expect(result?.outcomeKind).toBe('orphaned_success');
    expect(result?.voucherNo).toBe('V123');
  });

  it('returns null when there is no orphan to recover', async () => {
    const {consumeOrphanedIfAny} = await loadPaymentModule({
      consumeOrphanedPaymentResult: async () => null,
    });

    expect(await consumeOrphanedIfAny()).toBeNull();
  });
});
