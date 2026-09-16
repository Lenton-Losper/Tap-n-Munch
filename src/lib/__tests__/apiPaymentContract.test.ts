/**
 * The two places where the terminal's payment contract meets the wire.
 *
 * WHY THESE ARE WORTH TESTING SEPARATELY FROM THE LOGIC. Both defects behind them were of the same
 * shape: a value that was computed correctly and then never actually travelled.
 *
 *   #328 — the sale attempt key was to be generated per sale and sent as `x-idempotency-key`.
 *          A key held perfectly in CartContext and dropped before `fetch` is worth nothing, and
 *          neither the compiler nor a lifetime unit test can see the difference.
 *   #327 — the payment route answers with `outcome`, the field that distinguishes "paid" from
 *          "cancelled" from "cannot say". completePayment parsed `{canClose}` and threw the rest
 *          away, so the fix to the server was invisible on the device.
 *
 * Both are asserted against the ACTUAL fetch call, not against a helper's return value.
 *
 * api.ts reads NativeModules.RuntimeConfig at module load time and pulls in ./storage ->
 * react-native-encrypted-storage transitively, so it is required fresh inside
 * jest.isolateModulesAsync with the natives stubbed — the pattern already used by payment.test.ts.
 */
jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => 'test-token'),
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

import {withApi} from './helpers/apiHarness';

describe('#328 — the idempotency key reaches the wire', () => {
  it('createPOSOrder sends the key as the x-idempotency-key HEADER', async () => {
    const calls = await withApi(
      {status: 200, body: {orderId: 'o1', orderNumber: 7}},
      async (api, seen) => {
        await api.createPOSOrder('tok', {
          restaurantId: 'r1',
          items: [],
          subtotal: 10,
          total: 10,
          idempotencyKey: 'pos_abc_123',
        });
        return seen;
      },
    );

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-idempotency-key']).toBe('pos_abc_123');
  });

  it('sends the key ONLY in the header, never in the JSON body', async () => {
    // The route reads the header and nowhere else, so a key that arrives only in the body is the
    // same as no key at all — and would look correct in any log that prints the request payload.
    const calls = await withApi(
      {status: 200, body: {orderId: 'o1', orderNumber: 7}},
      async (api, seen) => {
        await api.createPOSOrder('tok', {
          restaurantId: 'r1',
          items: [],
          subtotal: 10,
          total: 10,
          idempotencyKey: 'pos_abc_123',
        });
        return seen;
      },
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.idempotencyKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('pos_abc_123');
  });
});

describe('#327 — completePayment surfaces the outcome, not just canClose', () => {
  it('returns the outcome discriminator for an unconfirmed payment', async () => {
    const result = await withApi(
      {
        status: 200,
        body: {
          success: false,
          canClose: false,
          outcome: 'left_pending_finatic_uncertain',
          reason: 'finatic_e04111',
        },
      },
      async api =>
        api.completePayment('order-868', 'tok', {
          status: 'failed',
          reference: 'UNCONFIRMED-1',
          amount: 33,
          paymentMethod: 'card',
        }),
    );

    // The exact fields the screen branches on. Before #327 this object was `{canClose: false}` and
    // order #868's food was released.
    expect(result.outcome).toBe('left_pending_finatic_uncertain');
    expect(result.success).toBe(false);
    expect(result.canClose).toBe(false);
  });

  it('returns corrected_to_paid so a false device failure can be shown as a sale', async () => {
    const result = await withApi(
      {status: 200, body: {success: true, canClose: true, outcome: 'corrected_to_paid'}},
      async api =>
        api.completePayment('o', 'tok', {
          status: 'failed',
          reference: 'r',
          amount: 1,
          paymentMethod: 'card',
        }),
    );

    expect(result.outcome).toBe('corrected_to_paid');
    expect(result.canClose).toBe(true);
  });

  it('treats an absent success field as true, not as false', async () => {
    // The plain happy-path response is `{success: true, canClose}`; an older build may omit the
    // field entirely. Reading a missing field as `false` would turn every ordinary settlement into
    // an unconfirmed one.
    const result = await withApi(
      {status: 200, body: {canClose: true}},
      async api =>
        api.completePayment('o', 'tok', {
          status: 'success',
          reference: 'r',
          amount: 1,
          paymentMethod: 'card',
        }),
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  it('surfaces ALREADY_PAID as a coded error the caller can classify (#326)', async () => {
    // This is the 409 that rendered a paid order as FAILED with a retry prompt.
    const err = await withApi(
      {status: 409, body: {error: 'Order is already paid', code: 'ALREADY_PAID'}},
      async api => {
        try {
          await api.completePayment('order-851', 'tok', {
            status: 'success',
            reference: 'r',
            amount: 51,
            paymentMethod: 'card',
          });
          return null;
        } catch (e) {
          return e as {code?: string; status?: number};
        }
      },
    );

    expect(err).not.toBeNull();
    expect(err?.code).toBe('ALREADY_PAID');
    expect(err?.status).toBe(409);
  });
});

/**
 * D-4 — the raw gateway result code reaches the wire.
 *
 * Same shape as the two defects this file was written for: a value the device HAD, computed
 * correctly, and never sent. `PaymentResult.gatewayResult` has carried "N002" since the native
 * boundary extracted it; the failure report dropped it, because an ambiguous outcome reports a
 * reference of `UNCONFIRMED-<epoch>` and nothing else describes what went wrong. All 21 `sale`
 * rows in staging payment_events have gateway_result_code NULL as a result.
 *
 * Asserted against the ACTUAL request body, for the reason the file header gives: a field held
 * perfectly and dropped before fetch is worth nothing, and neither the compiler nor a unit test on
 * the caller can see the difference.
 */
describe('D-4 — the gateway result code reaches the wire', () => {
  it('sends gatewayResult in the failure-report body', async () => {
    const calls = await withApi(
      {status: 200, body: {success: true, canClose: false, outcome: 'cancelled'}},
      async (api, seen) => {
        await api.completePayment('order-1', 'tok', {
          status: 'failed',
          reference: 'UNCONFIRMED-1787946108776',
          amount: 34,
          paymentMethod: 'card',
          gatewayResult: 'N002',
        });
        return seen;
      },
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.gatewayResult).toBe('N002');
    // It travels as its OWN field. The reference still identifies the attempt and must not be
    // made to carry a diagnostic — DECLINED-<code>-<epoch> already blurs the two and is not
    // extended here.
    expect(body.reference).toBe('UNCONFIRMED-1787946108776');
    expect(String(body.reference)).not.toContain('N002');
  });

  it('omits the field entirely when the device has no code', async () => {
    // An older APK, or any failure that never reached the gateway. Absent must mean "not
    // reported" on the wire, so the server can tell it apart from an empty answer.
    const calls = await withApi(
      {status: 200, body: {success: true, canClose: false, outcome: 'cancelled'}},
      async (api, seen) => {
        await api.completePayment('order-1', 'tok', {
          status: 'failed',
          reference: 'UNCONFIRMED-1',
          amount: 34,
          paymentMethod: 'card',
        });
        return seen;
      },
    );

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect('gatewayResult' in body).toBe(false);
  });
});
