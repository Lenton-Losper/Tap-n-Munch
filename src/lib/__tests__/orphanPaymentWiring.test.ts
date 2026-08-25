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
  /** #344 ruling 5 — what the reader actually reported. */
  outcomeKind?: string;
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
    /**
     * KEY-AWARE ON PURPOSE. A blanket `getItem -> stored` also answers the TERMINAL TOKEN read, so
     * getTerminalToken() returns null and processPaymentIntent early-returns "Session expired"
     * before the try block — the catch, and therefore site 2, is never reached, and the test
     * passes or fails for a reason nothing to do with orphans. Caught exactly that way: the #183
     * assertion reported `confirmed_failure` until the token was supplied.
     */
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : stored,
    );
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

/**
 * #344 RULING 5 — a non-success orphan is evidence, not rubbish.
 *
 * "A failed orphan still tells us a payment attempt reached a reader and how it ended." Site 1 used
 * to consume every cancel and every ambiguous result and drop it on the floor. It still does not
 * APPLY them — the operator is starting a fresh payment, and answering with someone's earlier
 * cancel would be wrong — but it now holds them with their outcome.
 */
describe('#344 ruling 5 — a non-success orphan is held, not dropped', () => {
  it('holds a user_cancelled orphan for THIS order, with its outcome', async () => {
    const {result, held} = await runWithOrphan(
      {outcome: 'user_cancelled', voucherNo: '', orderId: B, orphaned: true},
      B,
    );
    // Not applied: the operator asked to take a payment, not to be told about an old cancel.
    expect((result as {success?: boolean}).success).not.toBe(true);
    // But recorded, with what actually happened at the reader.
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe('non_success_not_applied');
    expect(held[0].outcomeKind).toBe('user_cancelled');
  });

  it('holds an ambiguous orphan rather than discarding it', async () => {
    const {held} = await runWithOrphan(
      {outcome: 'something_odd', voucherNo: '', orderId: B, orphaned: true},
      B,
    );
    expect(held).toHaveLength(1);
    expect(held[0].outcomeKind).toBe('orphaned_ambiguous');
  });

  it('still records the ORDER reason when it also names a different order', async () => {
    // Both things are true; the order mismatch is the more important one to show staff.
    const {held} = await runWithOrphan(
      {outcome: 'user_cancelled', voucherNo: '', orderId: A, orphaned: true},
      B,
    );
    expect(held[0].reason).toBe('different_order');
    expect(held[0].outcomeKind).toBe('user_cancelled');
  });
});

/**
 * #183 MUST SURVIVE RULING 5, and this is the assertion that proves it.
 *
 * Site 2 is inside the catch, so an orphan naming THIS order IS this attempt's result — whatever
 * it says. If a matching `user_cancelled` is not applied there, it falls through to
 * `orphaned_ambiguous`, the server verifies against a gateway that has no record of it, gets
 * E04111, and the order strands. That is #183 exactly, and native's own comment says an orphaned
 * USER CANCEL must not be reported as ambiguous.
 *
 * So `applyNonSuccess` differs between the two sites BY DESIGN. Anyone unifying them will break
 * this test, which is the point of it existing.
 */
async function runWithOrphanAtSiteTwoOnly(
  orphan: Record<string, unknown>,
  chargingOrderId: string,
): Promise<unknown> {
  let out: unknown;
  await jest.isolateModulesAsync(async () => {
    const {NativeModules, Platform} = require('react-native');
    Platform.OS = 'android';
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };
    const encrypted = require('react-native-encrypted-storage')
      .default as {getItem: jest.Mock; setItem: jest.Mock};
    let stored: string | null = null;
    /**
     * KEY-AWARE ON PURPOSE. A blanket `getItem -> stored` also answers the TERMINAL TOKEN read, so
     * getTerminalToken() returns null and processPaymentIntent early-returns "Session expired"
     * before the try block — the catch, and therefore site 2, is never reached, and the test
     * passes or fails for a reason nothing to do with orphans. Caught exactly that way: the #183
     * assertion reported `confirmed_failure` until the token was supplied.
     */
    encrypted.getItem.mockImplementation(async (key: string) =>
      key === 'flashtap_terminal_token' ? 'test-token' : stored,
    );
    encrypted.setItem.mockImplementation(async (_k: string, v: string) => {
      stored = v;
    });

    let call = 0;
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      launchPayment: jest.fn(),
      // Empty at site 1, present at site 2 — the shape of a callback that arrived DURING this
      // attempt rather than one left over from an earlier sale.
      consumeOrphanedPaymentResult: jest.fn(async () => {
        call += 1;
        return call === 1 ? null : orphan;
      }),
    };
    const payment = require('../payment') as typeof import('../payment');
    // prepare-payment reaches the network, which cannot resolve here, so the flow throws into the
    // catch — which is precisely the path site 2 lives on.
    out = await payment.processPaymentIntent(50, chargingOrderId);
  });
  return out;
}

describe('#183 — site 2 still applies a MATCHING cancel', () => {
  it('returns user_cancelled rather than letting it become ambiguous', async () => {
    const result = await runWithOrphanAtSiteTwoOnly(
      {outcome: 'user_cancelled', voucherNo: '', orderId: B, orphaned: true},
      B,
    );
    // The classification the server needs in order to cancel without a Finatic verify.
    expect((result as {outcomeKind?: string}).outcomeKind).toBe('user_cancelled');
  });

  it('but still HOLDS a cancel that names a DIFFERENT order', async () => {
    // Ruling 5 does not weaken #344: a mismatch is a mismatch whatever the outcome.
    const result = await runWithOrphanAtSiteTwoOnly(
      {outcome: 'user_cancelled', voucherNo: '', orderId: A, orphaned: true},
      B,
    );
    expect((result as {outcomeKind?: string}).outcomeKind).not.toBe(
      'user_cancelled',
    );
  });
});
