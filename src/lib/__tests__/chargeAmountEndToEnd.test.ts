/**
 * D-5 END TO END — the server's figure is the figure the reader is asked for.
 *
 * ================================================================================================
 * NOTHING BETWEEN THE HTTP BODY AND THE NATIVE CALL IS MOCKED
 * ================================================================================================
 *
 * The sibling suite (preparePaymentChargeContract) proves hop 3 in isolation: api.ts now parses
 * chargeCents out of the response. paymentNativeBoundary proves hop 4: payment.ts charges
 * prepared.chargeCents when it is given one — but it proves that against a MOCKED
 * prepareTerminalPayment whose mock fabricates the field, so it would stay green with hop 3 broken.
 * That is precisely how this defect survived: two green tests either side of the only broken hop.
 *
 * This file closes the gap by faking exactly two things — `fetch` and the native module — and
 * running everything between them for real:
 *
 *     server JSON body
 *       -> api.ts prepareTerminalPayment (real)
 *         -> payment.ts processPaymentIntent (real)
 *           -> PaymentModule.launchPayment(amountInCents, ...)   <- asserted here
 *
 * The assertion is on the FIRST ARGUMENT of launchPayment, which is the string of minor units the
 * native side zero-pads into `amt` and hands to WiseCashier. It is the last value this codebase
 * controls before a customer is asked for money.
 */

/** Marks this file as a MODULE. Without an import or export a test file lands in the GLOBAL
 *  scope, where its top-level `Call`/`Harness`/`ORDER_ID` collide with the identically named
 *  declarations in paymentNativeBoundary.test.ts — jest runs each file in its own registry and
 *  never notices, but tsc fails the whole project. */
export {};

type Call = [string, string, string];

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const MERCHANT_ORDER_NO = 'FT17879460993728015';

type Harness = {launches: Call[]; prepareCalls: number};

/**
 * Real api.ts + real payment.ts. Only `fetch` and NativeModules are faked.
 *
 * Platform.OS is forced to android because the RN preset defaults to ios, and processPaymentIntent
 * early-returns "not available on this platform" there — which would make every assertion below
 * pass vacuously. RuntimeConfig must be set or api.ts throws at import.
 */
async function run(
  callerAmount: number,
  serverBody: Record<string, unknown> | null,
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

    let prepareCalls = 0;
    (globalThis as unknown as {fetch: unknown}).fetch = async (
      url: string,
      init: RequestInit,
    ) => {
      const body = String(url).includes('/prepare-payment')
        ? ((prepareCalls += 1), serverBody)
        : {success: true};
      void init;
      return {
        ok: true,
        status: 200,
        headers: {get: () => null},
        json: async () => body,
        clone() {
          return this;
        },
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    };

    const launches: Call[] = [];
    NativeModules.PaymentModule = {
      launchRefund: jest.fn(),
      consumeOrphanedResult: jest.fn(async () => null),
      readWiretap: jest.fn(async () => []),
      clearWiretap: jest.fn(async () => undefined),
      recordWiretap: jest.fn(async () => undefined),
      launchPayment: jest.fn(async (...args: Call) => {
        launches.push(args);
        // A clean success, so the test is about the amount and nothing else.
        return {voucherNo: 'VCHR-1', businessOrderNo: MERCHANT_ORDER_NO};
      }),
    };

    const {processPaymentIntent} = require('../payment');
    await processPaymentIntent(callerAmount, ORDER_ID);
    out = {launches, prepareCalls};
  });
  return out;
}

/** The minor-unit string handed to native — the amount the customer is asked for. */
const amountCharged = (h: Harness) => h.launches[0]?.[0];

const SERVER_BODY = {
  orderId: ORDER_ID,
  merchantOrderNo: MERCHANT_ORDER_NO,
  created: true,
  chargeCents: 3900,
  tipCents: 500,
};

describe('D-5 end to end — server body to native amount', () => {
  it('a TIPPED charge asks the reader for bill + tip, not the bill', async () => {
    /**
     * THE DEFECT, END TO END. The caller passes the BILL deliberately — TableDetailScreen's own
     * comment says the tip travels separately so the two are never double-counted — and relies on
     * the server's chargeCents to become the charge. With hop 3 broken the reader was asked for
     * 34.00 while payment_tips recorded a 5.00 gratuity nobody collected.
     */
    const h = await run(34.0, SERVER_BODY);

    expect(h.prepareCalls).toBe(1);
    expect(amountCharged(h)).toBe('3900');
    expect(amountCharged(h)).not.toBe('3400');
  });

  it('a PART-PAID order asks for the remainder the server computed', async () => {
    // prepare-payment charges total minus already-settled. 37.00 total, 20.00 already collected.
    const h = await run(37.0, {...SERVER_BODY, chargeCents: 1700, tipCents: 0});

    expect(amountCharged(h)).toBe('1700');
    expect(amountCharged(h)).not.toBe('3700');
  });

  it('an ORDINARY whole-order sale is unchanged — the two figures agree', async () => {
    // The overwhelmingly common case. This must stay exactly as it was.
    const h = await run(34.0, {...SERVER_BODY, chargeCents: 3400, tipCents: 0});

    expect(amountCharged(h)).toBe('3400');
  });

  it('an OLDER WORKER that sends no chargeCents leaves the caller amount standing', async () => {
    const olderBody: Record<string, unknown> = {...SERVER_BODY};
      // An older worker does not send these fields at all -- deleted rather than set to
      // undefined, so JSON.stringify omits them exactly as that worker would.
      delete olderBody.chargeCents;
      delete olderBody.tipCents;

    const h = await run(34.0, olderBody);

    // Not '0', and not a throw. Exactly the pre-change behaviour.
    expect(amountCharged(h)).toBe('3400');
  });

  it('the reference the reader charges under is still the server-owned one', async () => {
    // Guards the other half of prepare-payment's contract while we are in here: the amount changed
    // hands, the identity must not have.
    const h = await run(34.0, SERVER_BODY);

    expect(h.launches[0]?.[2]).toBe(MERCHANT_ORDER_NO);
  });
});
