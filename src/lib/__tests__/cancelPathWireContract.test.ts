/**
 * THE CANCELLATION PATH ON THE WIRE. (Sprint 2026-09-28 brief — Riviera #160.)
 *
 * The real api.ts against a scripted fetch. Three things only the real functions can prove:
 *
 *   1. A WRONG PIN IS NOT AN EXPIRED SESSION, and it is POSTed ONCE. /authorize answers a wrong PIN
 *      with 401 PIN_MISMATCH; terminalFetch used to read every 401 as an expired terminal token,
 *      refresh, and re-POST the same wrong PIN (two strikes toward lockout), and then
 *      throwIfUnauthorized said "Terminal session expired".
 *   2. A TIMEOUT OR A DEAD NETWORK IS AN UNKNOWN OUTCOME (RequestOutcomeUnknownError), never a
 *      failure the caller may read as "nothing happened".
 *   3. C4/C5 responses on /rounds become their own typed errors, and a 5xx becomes UNKNOWN.
 */
export {};

jest.mock('../storage', () => ({
  getRefreshToken: jest.fn(async () => 'refresh-token'),
  saveTerminalToken: jest.fn(async () => undefined),
  saveRefreshToken: jest.fn(async () => undefined),
  saveRestaurantId: jest.fn(async () => undefined),
  saveTerminalId: jest.fn(async () => undefined),
  saveRestaurantName: jest.fn(async () => undefined),
  saveMerchantCredentials: jest.fn(async () => undefined),
}));

type Scripted =
  | {status: number; body?: unknown; raw?: string}
  | 'network'
  | 'hang';

type Call = {url: string; init: RequestInit};

/** Load api.ts fresh with a fetch that answers each call from `script`, in order. */
async function withScript<T>(
  script: Scripted[],
  run: (api: typeof import('../api'), calls: Call[]) => Promise<T>,
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
    const calls: Call[] = [];
    const queue = [...script];
    (globalThis as {fetch?: unknown}).fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({url, init});
      // The token refresh is answered on its own, so scripts describe only the calls under test.
      if (url.endsWith('/api/terminal/refresh')) {
        return {
          ok: true,
          status: 200,
          headers: {get: () => null},
          json: async () => ({accessToken: 'fresh-jwt', refreshToken: 'r2'}),
        };
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unscripted fetch ${url}`);
      }
      if (next === 'network') {
        throw new TypeError('Network request failed');
      }
      if (next === 'hang') {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), {name: 'AbortError'})),
          );
        });
      }
      const text = next.raw ?? JSON.stringify(next.body ?? {});
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: {get: () => null},
        json: async () => JSON.parse(text),
      };
    });
    const api = require('../api') as typeof import('../api');
    out = await run(api, calls);
  });
  return out;
}

const authorizeCalls = (calls: Call[]) => calls.filter(c => c.url.endsWith('/api/terminal/authorize'));
const TAB = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';

describe('authorizeTerminalAction — a wrong PIN is handled locally', () => {
  it('401 PIN_MISMATCH: coded PIN_MISMATCH, attempts left, NOT a session error, POSTed ONCE', async () => {
    await withScript(
      [{status: 401, body: {error: 'Invalid PIN', code: 'PIN_MISMATCH', attempts_remaining: 3}}],
      async (api, calls) => {
        const err = await api
          .authorizeTerminalAction('mgr-1', '0000', 'line_void', 'jwt')
          .catch(e => e);
        expect(err).toBeInstanceOf(api.ApiRequestError);
        expect(err).not.toBeInstanceOf(api.TerminalAuthError);
        expect(err.code).toBe('PIN_MISMATCH');
        expect(err.attemptsRemaining).toBe(3);
        expect(err.message).not.toMatch(/session/i);
        // THE DOUBLE STRIKE: exactly one POST, and no token refresh.
        expect(authorizeCalls(calls)).toHaveLength(1);
        expect(calls.some(c => c.url.endsWith('/api/terminal/refresh'))).toBe(false);
      },
    );
  });

  it('403 (no permission / not a member / no PIN): coded AUTHORIZATION_DENIED, not a session error', async () => {
    await withScript([{status: 403, body: {error: 'Authorization denied'}}], async (api, calls) => {
      const err = await api
        .authorizeTerminalAction('waiter-1', '1234', 'line_void', 'jwt')
        .catch(e => e);
      expect(err).toBeInstanceOf(api.ApiRequestError);
      expect(err).not.toBeInstanceOf(api.TerminalAuthError);
      expect(err.code).toBe('AUTHORIZATION_DENIED');
      expect(authorizeCalls(calls)).toHaveLength(1);
    });
  });

  it('CONTROL: a 401 WITHOUT PIN_MISMATCH is the terminal token — refresh once and retry', async () => {
    await withScript(
      [{status: 401, body: {error: 'Unauthorized'}}, {status: 200, body: {token_id: 't1', expires_at: 'x'}}],
      async (api, calls) => {
        await expect(
          api.authorizeTerminalAction('mgr-1', '1234', 'line_void', 'jwt'),
        ).resolves.toEqual({token_id: 't1', expires_at: 'x'});
        const posts = authorizeCalls(calls);
        expect(posts).toHaveLength(2);
        expect((posts[1].init.headers as Record<string, string>).Authorization).toBe(
          'Bearer fresh-jwt',
        );
      },
    );
  });

  it('a network failure is an unknown outcome, not a refusal', async () => {
    await withScript(['network'], async api => {
      const err = await api.authorizeTerminalAction('mgr-1', '1', 'line_void', 'jwt').catch(e => e);
      expect(err).toBeInstanceOf(api.RequestOutcomeUnknownError);
      expect(err.kind).toBe('network');
    });
  });
});

describe('amendTabLines — unknown outcomes and malformed bodies', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a TIMEOUT rejects as RequestOutcomeUnknownError(timeout), never a result', async () => {
    jest.useFakeTimers();
    await withScript(['hang'], async api => {
      const pending = api
        .amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt')
        .catch(e => e);
      await jest.advanceTimersByTimeAsync(api.AMEND_TIMEOUT_MS + 1);
      const err = await pending;
      expect(err).toBeInstanceOf(api.RequestOutcomeUnknownError);
      expect(err.kind).toBe('timeout');
    });
  });

  it('a network failure rejects as RequestOutcomeUnknownError(network)', async () => {
    await withScript(['network'], async api => {
      const err = await api
        .amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt')
        .catch(e => e);
      expect(err).toBeInstanceOf(api.RequestOutcomeUnknownError);
      expect(err.kind).toBe('network');
    });
  });

  it('a 200 that is not JSON comes back NOT well formed', async () => {
    await withScript([{status: 200, raw: '<html>gateway</html>'}], async api => {
      const r = await api.amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt');
      expect(r.well_formed).toBe(false);
    });
  });

  it('a 200 of {} comes back NOT well formed — it used to be a clean success', async () => {
    await withScript([{status: 200, body: {}}], async api => {
      const r = await api.amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt');
      expect(r.well_formed).toBe(false);
      expect(r.applied).toEqual([]);
    });
  });

  it('502 AMEND_FAILED still throws a coded ApiRequestError', async () => {
    await withScript([{status: 502, body: {error: 'x', code: 'AMEND_FAILED'}}], async api => {
      const err = await api
        .amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt')
        .catch(e => e);
      expect(err).toBeInstanceOf(api.ApiRequestError);
      expect(err.status).toBe(502);
    });
  });
});

const ROUND = {
  tabId: TAB,
  items: [{menuItemId: 'm1', name: 'Modena Pasta', quantity: 1}],
  subtotal: 240,
  total: 240,
  idempotencyKey: 'key-1',
};

describe('sendRound — C4, C5 and unknown outcomes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('duplicate: true is reported as a duplicate, with the SERVER items', async () => {
    await withScript(
      [
        {
          status: 200,
          body: {
            success: true,
            duplicate: true,
            order_id: 'o-160',
            order_number: 160,
            items: [
              {name: 'Modena Pasta', quantity: 1},
              {name: 'Beef Burger', quantity: 2},
            ],
            line_count: 2,
            station_counts: {kitchen: 2, bar: 0, unrouted: 0},
          },
        },
      ],
      async api => {
        const r = await api.sendRound(ROUND, 'jwt');
        expect(r.duplicate).toBe(true);
        expect(r.persisted_items).toEqual([
          {name: 'Modena Pasta', quantity: 1},
          {name: 'Beef Burger', quantity: 2},
        ]);
      },
    );
  });

  it('an old server duplicate (no items) is still a duplicate, with an empty server list', async () => {
    await withScript(
      [{status: 200, body: {success: true, duplicate: true, order_id: 'o1', order_number: 1}}],
      async api => {
        const r = await api.sendRound(ROUND, 'jwt');
        expect(r.duplicate).toBe(true);
        expect(r.persisted_items).toEqual([]);
      },
    );
  });

  it('409 IDEMPOTENCY_KEY_BODY_MISMATCH carries the ORIGINAL round the server has', async () => {
    await withScript(
      [
        {
          status: 409,
          body: {
            code: 'IDEMPOTENCY_KEY_BODY_MISMATCH',
            error: 'different body',
            order_id: 'o-160',
            order_number: 160,
            items: [{name: 'Modena Pasta', quantity: 1}],
          },
        },
      ],
      async api => {
        const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
        expect(err).toBeInstanceOf(api.RoundKeyMismatchError);
        expect(err.orderNumber).toBe(160);
        expect(err.items).toEqual([{name: 'Modena Pasta', quantity: 1}]);
      },
    );
  });

  it('C5 400 is a pricing refusal with the unavailable items, POSTed once', async () => {
    await withScript(
      [
        {
          status: 400,
          body: {
            code: 'MENU_ITEM_VARIANT_REQUIRED',
            error: 'Pick a size',
            unavailableItems: ['Modena Pasta', {name: 'Latte'}],
          },
        },
      ],
      async (api, calls) => {
        const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
        expect(err).toBeInstanceOf(api.RoundPricingRefusedError);
        expect(err.code).toBe('MENU_ITEM_VARIANT_REQUIRED');
        expect(err.unavailableItems).toEqual(['Modena Pasta', 'Latte']);
        expect(calls.filter(c => c.url.endsWith('/api/terminal/rounds'))).toHaveLength(1);
      },
    );
  });

  it.each([500, 502, 503])('a %i (not LINES_NOT_WRITTEN) is an UNKNOWN outcome', async status => {
    await withScript([{status, body: {error: 'boom'}}], async api => {
      const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
      expect(err).toBeInstanceOf(api.RoundOutcomeUnknownError);
      expect(err.kind).toBe('server');
    });
  });

  it('CONTROL: 502 LINES_NOT_WRITTEN keeps its own class', async () => {
    await withScript(
      [{status: 502, body: {code: 'LINES_NOT_WRITTEN', order_id: 'o1', order_number: 3}}],
      async api => {
        const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
        expect(err).toBeInstanceOf(api.RoundLinesNotWrittenError);
      },
    );
  });

  it('a network failure is an UNKNOWN outcome', async () => {
    await withScript(['network'], async api => {
      const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
      expect(err).toBeInstanceOf(api.RoundOutcomeUnknownError);
      expect(err.kind).toBe('network');
    });
  });

  it('a timeout is an UNKNOWN outcome', async () => {
    jest.useFakeTimers();
    await withScript(['hang'], async api => {
      const pending = api.sendRound(ROUND, 'jwt').catch(e => e);
      await jest.advanceTimersByTimeAsync(api.ROUND_TIMEOUT_MS + 1);
      const err = await pending;
      expect(err).toBeInstanceOf(api.RoundOutcomeUnknownError);
      expect(err.kind).toBe('timeout');
    });
  });

  it('a 200 with no order_id is not a confirmation', async () => {
    await withScript([{status: 200, body: {success: true}}], async api => {
      const err = await api.sendRound(ROUND, 'jwt').catch(e => e);
      expect(err).toBeInstanceOf(api.RoundOutcomeUnknownError);
    });
  });

  it('sends selectedVariants through untouched (C6 fingerprint input)', async () => {
    await withScript(
      [{status: 200, body: {success: true, duplicate: false, order_id: 'o1', order_number: 1}}],
      async (api, calls) => {
        await api.sendRound(
          {
            ...ROUND,
            items: [{menuItemId: 'm1', name: 'Latte', quantity: 1, selectedVariants: {Size: 'Large'}}],
          },
          'jwt',
        );
        expect(JSON.parse(String(calls[0].init.body)).items[0].selectedVariants).toEqual({
          Size: 'Large',
        });
      },
    );
  });
});

describe('payment calls get NO deadline', () => {
  it('terminalFetch only passes a signal when a caller opts in', async () => {
    await withScript([{status: 200, body: {orders: []}}], async (api, calls) => {
      await api.getOrders('jwt');
      expect(calls[0].init.signal).toBeUndefined();
    });
  });
});
