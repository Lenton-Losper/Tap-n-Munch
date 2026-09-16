/**
 * D-5 — the server's charge figure must survive into the amount the reader is asked for.
 *
 * ================================================================================================
 * WHY THIS FILE USES THE REAL PARSER, AND WHY THAT IS THE ENTIRE POINT
 * ================================================================================================
 *
 * The contract has four hops:
 *
 *   1. prepare-payment computes chargeCents = (order total - already settled) + tip
 *   2. it RETURNS chargeCents and tipCents in the JSON body        ← always did
 *   3. api.ts prepareTerminalPayment parses that body               ← DROPPED BOTH FIELDS
 *   4. payment.ts charges prepared.chargeCents when present         ← therefore never fired
 *
 * Hop 3 was the break. The return TYPE declared both fields, so hop 4 compiled and read correctly;
 * the parse cast named three fields and the returned object literal listed the same three, so
 * `prepared.chargeCents` was `undefined` on every call that has ever been made. The device charged
 * the caller's own number instead of the server's.
 *
 * THE EXISTING TESTS COULD NOT SEE IT. `paymentNativeBoundary.test.ts` mocks
 * `prepareTerminalPayment` and its mock FABRICATES `chargeCents`, with a comment asserting the
 * server "returns it". Only two test files referenced the function and both mocked it, so no test
 * had ever exercised the real response parsing. Those tests proved payment.ts consumes a field its
 * own data source never provided — a blind test over an inert fix.
 *
 * So this file stubs `fetch`, not the parser. Everything from the HTTP body onward is real code.
 */
import {prepareTerminalPayment} from '../api';

type Json = Record<string, unknown>;

const TOKEN = 'terminal-token';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function stubFetch(body: Json, status = 200) {
  const calls: Array<{url: string; init: RequestInit}> = [];
  (globalThis as unknown as {fetch: unknown}).fetch = async (
    url: string,
    init: RequestInit,
  ) => {
    calls.push({url, init});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {get: () => null},
      json: async () => body,
      clone() {
        return this;
      },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return calls;
}

/** What the server actually sends — prepare-payment/route.ts's success response, field for field. */
const SERVER_BODY = {
  orderId: ORDER_ID,
  merchantOrderNo: 'FT17879460993728015',
  created: true,
  chargeCents: 3900,
  tipCents: 500,
  outcome: null,
  staffMessage: null,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('D-5 — prepareTerminalPayment carries the server figure', () => {
  it('parses chargeCents and tipCents out of a real response body', async () => {
    stubFetch(SERVER_BODY);

    const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

    // The defect, in two assertions. Both were `undefined` before the parser named the fields.
    expect(prepared.chargeCents).toBe(3900);
    expect(prepared.tipCents).toBe(500);
    // ...and the fields that always worked still do.
    expect(prepared.merchantOrderNo).toBe('FT17879460993728015');
    expect(prepared.created).toBe(true);
  });

  it('the figure is carried VERBATIM — the terminal does no arithmetic on it', async () => {
    // A bill of 34.00 with a 5.00 tip. If this end ever starts computing, the two sides can
    // disagree and a gate compares the wrong number against a charge already made.
    stubFetch({...SERVER_BODY, chargeCents: 3400 + 500, tipCents: 500});

    const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

    expect(prepared.chargeCents).toBe(3900);
    // Not the bill, and not the tip — the sum the server decided.
    expect(prepared.chargeCents).not.toBe(3400);
  });

  it('a part-paid order carries the REMAINDER, not the order total', async () => {
    // prepare-payment charges total minus what has already been settled. The terminal must not
    // re-derive that from the order it has on screen.
    stubFetch({...SERVER_BODY, chargeCents: 1700, tipCents: 0});

    const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

    expect(prepared.chargeCents).toBe(1700);
  });

  describe('an older worker that has never heard of these fields', () => {
    it('omits them entirely rather than reporting zero', async () => {
      const olderBody: Record<string, unknown> = {...SERVER_BODY};
      // An older worker does not send these fields at all -- deleted rather than set to
      // undefined, so JSON.stringify omits them exactly as that worker would.
      delete olderBody.chargeCents;
      delete olderBody.tipCents;
      stubFetch(olderBody);

      const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

      /**
       * ABSENT, NOT 0. payment.ts only overrides its own amount when chargeCents is a positive
       * number, so an absent field leaves the caller's figure standing — which is exactly how a
       * terminal on this build must behave against a worker without the change. Coercing a
       * missing field to 0 and charging that is the one outcome worse than charging the old
       * number.
       */
      expect(prepared.chargeCents).toBeUndefined();
      expect(prepared.tipCents).toBeUndefined();
      expect(prepared.merchantOrderNo).toBe('FT17879460993728015');
    });

    it.each([
      ['null', null],
      ['a string', 'not-a-number'],
      ['zero', 0],
      ['negative', -100],
    ])('drops a chargeCents that is %s', async (_label, value) => {
      stubFetch({...SERVER_BODY, chargeCents: value});

      const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

      // Never passed on as a charge. An unusable figure must not become the amount on the reader.
      expect(prepared.chargeCents).toBeUndefined();
    });

    it('keeps a tipCents of 0, which is a real answer', async () => {
      // 0 is "no gratuity", not "no answer" — distinct from absent, and it must survive.
      stubFetch({...SERVER_BODY, tipCents: 0});

      const prepared = await prepareTerminalPayment(ORDER_ID, TOKEN);

      expect(prepared.tipCents).toBe(0);
    });
  });
});
