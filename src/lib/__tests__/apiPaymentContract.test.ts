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

type FetchCall = {url: string; init: RequestInit};

async function withApi<T>(
  respondWith: {status: number; body: unknown},
  run: (
    api: typeof import('../api'),
    calls: FetchCall[],
  ) => Promise<T>,
): Promise<T> {
  let out!: T;
  await jest.isolateModulesAsync(async () => {
    const {NativeModules} = require('react-native');
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };

    const calls: FetchCall[] = [];
    (globalThis as {fetch?: unknown}).fetch = jest.fn(
      async (url: string, init: RequestInit) => {
        calls.push({url, init});
        const text = JSON.stringify(respondWith.body);
        return {
          ok: respondWith.status >= 200 && respondWith.status < 300,
          status: respondWith.status,
          headers: {get: () => null},
          json: async () => JSON.parse(text),
          text: async () => text,
          clone: () => ({text: async () => text}),
        };
      },
    );

    const api = require('../api') as typeof import('../api');
    out = await run(api, calls);
  });
  return out;
}

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
