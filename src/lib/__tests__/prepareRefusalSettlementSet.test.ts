/**
 * SETTLEMENT_SET_NOT_CLAIMABLE, ORDER_NOTHING_OWED and NOTHING_LEFT_TO_CHARGE from prepare-payment
 * (Sprint 2026-09-29, F-TERMPAY task 3).
 *
 * The chain under test is the real one: global fetch answers prepare-payment with the server's 409
 * body -> api.ts parseApiError -> payment.ts processPaymentIntent. The native module records whether
 * the card reader was ever launched.
 *
 * Before this change SETTLEMENT_SET_NOT_CLAIMABLE and ORDER_NOTHING_OWED fell to 'ambiguous', which
 * sent the screen to Finatic verification and then to a FAILED report -- for a set of orders another
 * payment had just settled, and with no card ever presented.
 */
import {prepareRefusalMessage, refusedOrderIds} from '../settlementRefusal';
import {
  PREPARE_REFUSAL_CANCELLED,
  PREPARE_REFUSAL_CHANGED,
  PREPARE_REFUSAL_HELD,
  PREPARE_REFUSAL_NOTHING_OWED,
  PREPARE_REFUSAL_ORDER_CHANGED,
  PREPARE_REFUSAL_PAID,
} from '../../constants/settlementRefusalCopy';

const LEAD = '11111111-1111-4111-8111-111111111111';
const SIB = '22222222-2222-4222-8222-222222222222';
const SIB2 = '33333333-3333-4333-8333-333333333333';

type Run = {
  result: import('../payment').PaymentResult;
  launchCalls: number;
  prepareBodies: Array<Record<string, unknown>>;
};

async function run(
  status: number,
  body: Record<string, unknown>,
  orderIds = [LEAD, SIB],
  nativeRejectCode: string | null = null,
): Promise<Run> {
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

    const launchPayment = jest.fn(async () => {
      if (nativeRejectCode) {
        throw Object.assign(new Error('native refused'), {code: nativeRejectCode});
      }
      return {voucherNo: 'V', businessOrderNo: 'FT-1'};
    });
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      consumeOrphanedResult: jest.fn(async () => null),
      readWiretap: jest.fn(async () => []),
      clearWiretap: jest.fn(async () => undefined),
      recordWiretap: jest.fn(async () => undefined),
      launchPayment,
    };

    const prepareBodies: Array<Record<string, unknown>> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/prepare-payment')) {
        prepareBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: {get: () => null},
          json: async () => body,
        };
      }
      return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({})};
    });

    const {processPaymentIntent} = require('../payment');
    const result = await processPaymentIntent(34, orderIds.join(','));
    out = {result, launchCalls: launchPayment.mock.calls.length, prepareBodies};
  });
  return out;
}

const notClaimable = (rows: Array<[string, number, string]>) => ({
  error: 'Part of this bill has already been paid, cancelled, or is held for review.',
  code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
  orders: rows.map(([id]) => ({order_id: id, payment_status: 'x', status: 'y'})),
  not_claimable: rows.map(([order_id, order_number, reason]) => ({order_id, order_number, reason})),
});

describe('prepare-payment says the set is not claimable', () => {
  it.each([
    ['paid', PREPARE_REFUSAL_PAID, '#12 paid'],
    ['cancelled', PREPARE_REFUSAL_CANCELLED, '#12 cancelled'],
    ['held', PREPARE_REFUSAL_HELD, '#12 held for review'],
  ])('a %s sibling: not_started, the reader never launched, the reason in words', async (reason, sentence, listed) => {
    const {result, launchCalls} = await run(409, notClaimable([[SIB, 12, reason]]));

    expect(launchCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.outcomeKind).toBe('not_started');
    expect(result.prepareRefusal?.code).toBe('SETTLEMENT_SET_NOT_CLAIMABLE');
    expect(result.prepareRefusal?.notClaimable).toEqual([{orderId: SIB, orderNumber: 12, reason}]);

    const msg = prepareRefusalMessage(result.prepareRefusal!);
    expect(msg.body.startsWith(sentence)).toBe(true);
    expect(msg.body).toContain(listed);
    expect(msg.body).toContain('No card was charged');
    expect(refusedOrderIds(result.prepareRefusal!)).toEqual([SIB]);
  });

  it('a mixed valid + invalid set names only the refused orders, with the mixed sentence', async () => {
    const {result, launchCalls} = await run(
      409,
      notClaimable([
        [SIB, 12, 'paid'],
        [SIB2, 13, 'held'],
      ]),
      [LEAD, SIB, SIB2],
    );

    expect(launchCalls).toBe(0);
    expect(result.outcomeKind).toBe('not_started');
    const refused = refusedOrderIds(result.prepareRefusal!);
    expect(refused).toEqual([SIB, SIB2]);
    expect(refused).not.toContain(LEAD);
    const msg = prepareRefusalMessage(result.prepareRefusal!);
    expect(msg.body.startsWith(PREPARE_REFUSAL_CHANGED)).toBe(true);
    expect(msg.body).toContain('#12 paid, #13 held for review');
  });

  it('a worker that predates not_claimable still names the orders (reason unknown -> changed)', async () => {
    const {result, launchCalls} = await run(409, {
      error: 'Part of this bill has already been paid.',
      code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
      orders: [{order_id: SIB, payment_status: 'paid', status: 'completed'}],
    });
    expect(launchCalls).toBe(0);
    expect(result.prepareRefusal?.notClaimable).toEqual([{orderId: SIB, orderNumber: null, reason: 'other'}]);
    expect(prepareRefusalMessage(result.prepareRefusal!).body).toBe(PREPARE_REFUSAL_CHANGED);
  });

  it('ORDER_NOTHING_OWED names the orders owing nothing; the reader never launched', async () => {
    const {result, launchCalls} = await run(409, {
      error: 'This order has nothing left to pay.',
      code: 'ORDER_NOTHING_OWED',
      order_ids_owing_nothing: [LEAD],
    });
    expect(launchCalls).toBe(0);
    expect(result.outcomeKind).toBe('not_started');
    expect(refusedOrderIds(result.prepareRefusal!)).toEqual([LEAD]);
    expect(prepareRefusalMessage(result.prepareRefusal!).body).toBe(PREPARE_REFUSAL_NOTHING_OWED);
  });

  it('NOTHING_LEFT_TO_CHARGE: typed, not_started, no launch', async () => {
    const {result, launchCalls} = await run(409, {
      error: 'Those items have already been paid for.',
      code: 'NOTHING_LEFT_TO_CHARGE',
    });
    expect(launchCalls).toBe(0);
    expect(result.prepareRefusal?.code).toBe('NOTHING_LEFT_TO_CHARGE');
  });

  it('ORDER_CHANGED_DURING_PREPARE: typed, not_started, no launch, the bill-changed sentence', async () => {
    const {result, launchCalls} = await run(409, {
      error: 'This bill changed while the payment was being set up.',
      code: 'ORDER_CHANGED_DURING_PREPARE',
    });
    expect(launchCalls).toBe(0);
    expect(result.outcomeKind).toBe('not_started');
    expect(result.prepareRefusal?.code).toBe('ORDER_CHANGED_DURING_PREPARE');
    expect(prepareRefusalMessage(result.prepareRefusal!).body).toBe(PREPARE_REFUSAL_ORDER_CHANGED);
  });

  it('the device sends the whole set to prepare-payment (so the server can see every order)', async () => {
    const {prepareBodies} = await run(409, notClaimable([[SIB, 12, 'paid']]));
    expect(prepareBodies).toHaveLength(1);
    expect(prepareBodies[0].order_ids).toEqual([LEAD, SIB]);
  });

  it('POSITIVE CONTROL: a 200 prepare launches the reader exactly once and carries no refusal', async () => {
    const {result, launchCalls} = await run(200, {
      orderId: LEAD,
      merchantOrderNo: 'FT-1',
      created: true,
      chargeCents: 3400,
    });
    expect(launchCalls).toBe(1);
    expect(result.prepareRefusal).toBeUndefined();
  });

  it('a refusal-shaped code raised AFTER the reader opened is not treated as a prepare refusal', async () => {
    // Only prepare-payment's answer means "nothing was presented". Once the reader has run, the
    // same string from anywhere else must keep going through verification.
    const {result, launchCalls} = await run(
      200,
      {orderId: LEAD, merchantOrderNo: 'FT-1', created: true, chargeCents: 3400},
      [LEAD, SIB],
      'SETTLEMENT_SET_NOT_CLAIMABLE',
    );
    expect(launchCalls).toBe(1);
    expect(result.prepareRefusal).toBeUndefined();
    expect(result.outcomeKind).toBe('ambiguous');
  });

  it('an unrelated 409 code carries no typed refusal', async () => {
    const {result, launchCalls} = await run(409, {error: 'x', code: 'SOME_FUTURE_CODE'});
    expect(launchCalls).toBe(0);
    expect(result.prepareRefusal).toBeUndefined();
  });
});
