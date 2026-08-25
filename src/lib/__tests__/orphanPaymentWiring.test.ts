/**
 * #344 — that processPaymentIntent ACTUALLY applies the guard, and holds what it will not apply.
 *
 * WHY THIS IS SEPARATE FROM orphanPaymentGuard.test.ts. That suite proves the decision is right.
 * It says nothing about whether payment.ts consults it — and a correct rule that no call site uses
 * is the exact shape of defect this project has been bitten by before (a fix that shipped inert
 * because the value was computed and never read). These assertions drive processPaymentIntent
 * itself and check what came back and what was persisted.
 *
 * The two facts asserted are the ruling's two halves: DO NOT APPLY, and DO NOT DISCARD.
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

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

type Held = {
  orphanOrderId: string;
  seenWhileChargingOrderId: string;
  reason: string;
  voucherNo?: string;
};

/**
 * Load payment.ts with a native module that hands back one orphaned SALE, and capture whatever it
 * decides to hold. The hold is captured at the EncryptedStorage boundary rather than by mocking
 * storage.ts, so the assertion covers the real serialisation path too.
 */
async function runWithOrphan(
  orphan: Record<string, unknown>,
  chargingOrderId: string,
): Promise<{result: unknown; held: Held[]}> {
  let out!: {result: unknown; held: Held[]};
  await jest.isolateModulesAsync(async () => {
    const {NativeModules, Platform} = require('react-native');
    /**
     * processPaymentIntent returns "not available on this platform" unless Platform.OS is
     * android, and the RN jest preset defaults it to ios. Without this the orphan branch never
     * runs at all — and the two "the orphan was not applied" assertions below would pass
     * VACUOUSLY, for the wrong reason. Caught exactly that way while writing these.
     */
    Platform.OS = 'android';
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };

    let stored: string | null = null;
    const encrypted =
      require('react-native-encrypted-storage').default as {
        getItem: jest.Mock;
        setItem: jest.Mock;
      };
    encrypted.getItem.mockImplementation(async () => stored);
    encrypted.setItem.mockImplementation(async (_k: string, v: string) => {
      stored = v;
    });

    let consumed = false;
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      // Fails AFTER the orphan branch has run, so the test never reaches the network. What the
      // orphan branch did is already decided by then.
      launchPayment: jest.fn(async () => {
        throw new Error('launch not exercised in this test');
      }),
      consumeOrphanedPaymentResult: jest.fn(async () => {
        if (consumed) {
          return null;
        }
        consumed = true;
        return orphan;
      }),
    };

    const payment = require('../payment') as typeof import('../payment');
    let result: unknown;
    try {
      result = await payment.processPaymentIntent(50, chargingOrderId);
    } catch (err) {
      result = {threw: String(err)};
    }
    out = {result, held: stored ? (JSON.parse(stored) as Held[]) : []};
  });
  return out;
}

describe('#344 wiring — an orphan for a DIFFERENT order', () => {
  it('is NOT returned as this order’s payment result', async () => {
    const {result} = await runWithOrphan(
      {outcome: 'success', voucherNo: 'V-A-999', orderId: A, orphaned: true},
      B,
    );
    // Before #344 this returned {success: true, voucherNo: 'V-A-999'} and order B was settled on
    // order A's card. Whatever comes back now, it must not be that success.
    expect((result as {voucherNo?: string}).voucherNo).not.toBe('V-A-999');
    expect((result as {success?: boolean}).success).not.toBe(true);
  });

  it('IS persisted, with the reason and both order ids', async () => {
    const {held} = await runWithOrphan(
      {outcome: 'success', voucherNo: 'V-A-999', orderId: A, orphaned: true},
      B,
    );
    // "Do not apply" without "do not discard" would lose a card transaction that really happened.
    expect(held).toHaveLength(1);
    expect(held[0].orphanOrderId).toBe(A);
    expect(held[0].seenWhileChargingOrderId).toBe(B);
    expect(held[0].reason).toBe('different_order');
    expect(held[0].voucherNo).toBe('V-A-999');
  });
});

describe('#344 wiring — an orphan with NO order id', () => {
  it('is not applied, and is held as unknown_order', async () => {
    const {result, held} = await runWithOrphan(
      // Native sends '' rather than omitting the key.
      {outcome: 'success', voucherNo: 'V-?-777', orderId: '', orphaned: true},
      B,
    );
    expect((result as {voucherNo?: string}).voucherNo).not.toBe('V-?-777');
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe('unknown_order');
    expect(held[0].voucherNo).toBe('V-?-777');
  });
});

describe('#344 wiring — an orphan for THIS order still works', () => {
  it('IS returned, and is NOT held', async () => {
    // The case the recovery mechanism exists for. A guard that broke this would be worse than the
    // defect it fixes: every recovered payment would strand.
    const {result, held} = await runWithOrphan(
      {outcome: 'success', voucherNo: 'V-B-111', orderId: B, orphaned: true},
      B,
    );
    expect((result as {success?: boolean}).success).toBe(true);
    expect((result as {voucherNo?: string}).voucherNo).toBe('V-B-111');
    expect(held).toEqual([]);
  });

  it('matches a tab settle whose ids are listed in a different order', async () => {
    const {result, held} = await runWithOrphan(
      {
        outcome: 'success',
        voucherNo: 'V-AB-222',
        orderId: `${B},${A}`,
        orphaned: true,
      },
      `${A},${B}`,
    );
    expect((result as {voucherNo?: string}).voucherNo).toBe('V-AB-222');
    expect(held).toEqual([]);
  });
});
