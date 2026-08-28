/**
 * WHAT setMenuItemAvailability PUTS ON THE WIRE, AND WHAT IT DOES WITH THE ANSWER.
 *
 * THE ONE THAT MATTERS: A 403 MUST NOT SEND THE DEVICE INTO REFRESH-AND-RETRY.
 *
 * The route answers 403 when the PIN did not authorise the change — a business answer about a
 * person, which no amount of refreshing the terminal's own JWT can alter. Every route written
 * before waiter-led service ran its response through throwIfUnauthorized, which collapses 401 and
 * 403 into a single TerminalAuthError; on this route that would hand a "wrong person" answer to
 * the session-expiry machinery and start a retry that cannot succeed and cannot terminate. That is
 * the failure class that produced #327.
 *
 * THE 401 CASE IS IN HERE FOR A REASON. Asserting "a 403 makes one request" is worthless on its
 * own — a client that never retried anything would pass it. So the same suite proves the retry
 * machinery is LIVE and REACHABLE on this exact call by driving a 401 through it and counting two
 * requests, the second of them the token refresh. One request on 403, two on 401, same function,
 * same harness. Only a client that distinguishes them passes both.
 *
 * HOW TO SEE IT FAIL (done once, deliberately): in api.ts, change this route's
 * `throwIfTerminalSessionExpired(response)` to `throwIfUnauthorized(response)`. The 403 test then
 * fails on `TerminalAuthError: Terminal session expired` where a refusal was expected — the exact
 * regression the comment in api.ts warns about.
 */
import {withApi} from './helpers/apiHarness';

/**
 * A refresh token must be PRESENT for the 401 control case to mean anything: refreshAccessToken
 * returns null without ever fetching when storage has none, and the suite would then count one
 * request for 401 and one for 403 and prove nothing.
 */
jest.mock('../storage', () => ({
  getRefreshToken: jest.fn(async () => 'refresh-token'),
  saveTerminalToken: jest.fn(async () => undefined),
  saveRefreshToken: jest.fn(async () => undefined),
  saveRestaurantId: jest.fn(async () => undefined),
  saveTerminalId: jest.fn(async () => undefined),
  saveRestaurantName: jest.fn(async () => undefined),
  saveMerchantCredentials: jest.fn(async () => undefined),
}));

const PARAMS = {
  itemId: 'item-77',
  userId: 'user-9',
  authorizationTokenId: 'auth-token-1',
  available: false,
};

describe('setMenuItemAvailability — the wire contract', () => {
  it('posts the briefed body to the briefed route', async () => {
    await withApi(
      {
        status: 200,
        body: {
          ok: true,
          item: {id: 'item-77', name: 'Beef Fillet', status: 'hidden'},
          hidden: true,
        },
      },
      async (api, calls) => {
        const outcome = await api.setMenuItemAvailability(PARAMS, 'jwt');

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(
          'https://example.invalid/api/terminal/menu-items/item-77/availability',
        );
        expect(calls[0].init.method).toBe('POST');
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
          user_id: 'user-9',
          authorization_token_id: 'auth-token-1',
          available: false,
        });

        expect(outcome).toEqual({
          ok: true,
          item: {id: 'item-77', name: 'Beef Fillet', status: 'hidden'},
          hidden: true,
        });
      },
    );
  });

  it('sends available:true for a restore', async () => {
    await withApi(
      {
        status: 200,
        body: {
          ok: true,
          item: {id: 'item-77', name: 'Beef Fillet', status: 'available'},
          hidden: false,
        },
      },
      async (api, calls) => {
        const outcome = await api.setMenuItemAvailability(
          {...PARAMS, available: true},
          'jwt',
        );

        expect(JSON.parse(String(calls[0].init.body)).available).toBe(true);
        expect(outcome.ok && outcome.hidden).toBe(false);
      },
    );
  });
});

describe('setMenuItemAvailability — 403 is not a session problem', () => {
  it('makes exactly ONE request on 403 and never reaches the token refresh', async () => {
    await withApi(
      {
        status: 403,
        body: {
          ok: false,
          refusal: 'authorization_failed',
          message: 'That PIN did not work.',
        },
      },
      async (api, calls) => {
        const outcome = await api.setMenuItemAvailability(PARAMS, 'jwt');

        // ONE. Not two, not a loop.
        expect(calls).toHaveLength(1);
        expect(calls.map(call => call.url).join(' ')).not.toContain('/refresh');

        // And it came back as an answer to render, not an exception to recover from.
        expect(outcome).toEqual({
          ok: false,
          refusal: 'authorization_failed',
          message: 'That PIN did not work.',
        });
      },
    );
  });

  it('DOES refresh on 401 — the control that proves the 403 assertion is not vacuous', async () => {
    await withApi({status: 401, body: {error: 'expired'}}, async (api, calls) => {
      await expect(api.setMenuItemAvailability(PARAMS, 'jwt')).rejects.toThrow(
        api.TerminalAuthError,
      );

      // The availability POST, then the refresh it correctly attempted. Same code path, one
      // status apart, and it behaves completely differently — which is the whole point.
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.map(call => call.url).join(' ')).toContain('/refresh');
    });
  });
});

describe('setMenuItemAvailability — refusals are answers, not errors', () => {
  it('returns already_in_that_state from a 200 without throwing', async () => {
    await withApi(
      {
        status: 200,
        body: {
          ok: false,
          refusal: 'already_in_that_state',
          message: 'Somebody already took this off the menu.',
        },
      },
      async (api, calls) => {
        const outcome = await api.setMenuItemAvailability(PARAMS, 'jwt');

        expect(calls).toHaveLength(1);
        expect(outcome).toEqual({
          ok: false,
          refusal: 'already_in_that_state',
          message: 'Somebody already took this off the menu.',
        });
      },
    );
  });

  it('returns item_not_found from a 404 without throwing', async () => {
    await withApi(
      {
        status: 404,
        body: {
          ok: false,
          refusal: 'item_not_found',
          message: 'This dish is no longer on the menu.',
        },
      },
      async (api, calls) => {
        const outcome = await api.setMenuItemAvailability(PARAMS, 'jwt');

        expect(calls).toHaveLength(1);
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.refusal).toBe('item_not_found');
      },
    );
  });

  it('throws on a 400 that carries no refusal — a malformed request is a real error', async () => {
    await withApi(
      {status: 400, body: {error: 'invalid item id'}},
      async api => {
        await expect(
          api.setMenuItemAvailability(PARAMS, 'jwt'),
        ).rejects.toThrow(api.ApiRequestError);
      },
    );
  });
});
