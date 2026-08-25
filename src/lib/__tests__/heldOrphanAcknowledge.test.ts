/**
 * #344 residual — ACKNOWLEDGING ONE HELD PAYMENT MUST NOT DESTROY THE OTHERS.
 *
 * The notice rendered N held records above a SINGLE button wired to a whole-store wipe. An
 * operator who had genuinely checked one payment therefore deleted every held record, including a
 * case-3 one — the record that never clears on its own, because it names no order to report
 * against. A card transaction destroyed by a button captioned "I have checked this payment".
 *
 * The second test is the one that would have caught the subtler regression: removal is by VALUE
 * identity, not list position, because the reporting pass rewrites this list on every screen focus.
 * An index captured at render time can point at a different record by the time it is pressed.
 */
const store: Record<string, string> = {};

jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
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

import {
  acknowledgeHeldOrphanPayment,
  getHeldOrphanPayments,
  heldOrphanIdentity,
  holdOrphanPayment,
  type HeldOrphanPayment,
} from '../storage';

/** A case-2 record: it names an order, so the reporting pass can resolve it by itself. */
const CASE_2: HeldOrphanPayment = {
  orphanOrderId: '44444444-4444-4444-8444-444444444444',
  seenWhileChargingOrderId: '55555555-5555-4555-8555-555555555555',
  reason: 'different_order',
  voucherNo: 'V-CASE-2',
  businessOrderNo: 'FT-CASE-2',
  heldAt: '2026-08-25T10:00:00.000Z',
};

/** A case-3 record: no order id at all. Nothing will ever clear this one automatically. */
const CASE_3: HeldOrphanPayment = {
  orphanOrderId: '',
  seenWhileChargingOrderId: '55555555-5555-4555-8555-555555555555',
  reason: 'unknown_order',
  voucherNo: 'V-CASE-3',
  businessOrderNo: 'FT-CASE-3',
  heldAt: '2026-08-25T10:05:00.000Z',
};

beforeEach(() => {
  for (const k of Object.keys(store)) {
    delete store[k];
  }
});

describe('acknowledging one held payment', () => {
  it('removes only that record and keeps the rest', async () => {
    await holdOrphanPayment(CASE_2);
    await holdOrphanPayment(CASE_3);
    expect(await getHeldOrphanPayments()).toHaveLength(2);

    const outcome = await acknowledgeHeldOrphanPayment(heldOrphanIdentity(CASE_2));

    expect(outcome.removed).toBe(1);
    const left = await getHeldOrphanPayments();
    expect(left).toHaveLength(1);
    // The case-3 record survives. Under the old whole-store wipe this array was empty, and the
    // only trace of a real card transaction was gone.
    expect(left[0].voucherNo).toBe('V-CASE-3');
  });

  it('acknowledging the case-3 record leaves the case-2 one reportable', async () => {
    await holdOrphanPayment(CASE_2);
    await holdOrphanPayment(CASE_3);

    await acknowledgeHeldOrphanPayment(heldOrphanIdentity(CASE_3));

    const left = await getHeldOrphanPayments();
    expect(left).toHaveLength(1);
    expect(left[0].orphanOrderId).toBe(CASE_2.orphanOrderId);
  });

  it('targets the record by value, not by position', async () => {
    await holdOrphanPayment(CASE_2);
    await holdOrphanPayment(CASE_3);

    // The identity is captured while CASE_3 is second...
    const identity = heldOrphanIdentity(CASE_3);

    // ...and then the reporting pass resolves CASE_2 and rewrites the list, so CASE_3 is now
    // FIRST. An index-based acknowledge would now delete the wrong record — or, here, the only
    // remaining one.
    const {setHeldOrphanPayments} = require('../storage') as {
      setHeldOrphanPayments: (rows: HeldOrphanPayment[]) => Promise<void>;
    };
    await setHeldOrphanPayments([CASE_3]);

    const outcome = await acknowledgeHeldOrphanPayment(identity);
    expect(outcome.removed).toBe(1);
    expect(await getHeldOrphanPayments()).toHaveLength(0);
  });

  it('is a no-op when the record has already gone, and says so', async () => {
    await holdOrphanPayment(CASE_2);

    // The reporting pass settled and dropped it between render and press. Acknowledging must not
    // remove something else in its place.
    const {setHeldOrphanPayments} = require('../storage') as {
      setHeldOrphanPayments: (rows: HeldOrphanPayment[]) => Promise<void>;
    };
    await setHeldOrphanPayments([CASE_3]);

    const outcome = await acknowledgeHeldOrphanPayment(heldOrphanIdentity(CASE_2));

    expect(outcome.removed).toBe(0);
    expect(await getHeldOrphanPayments()).toHaveLength(1);
  });
});

export {};
