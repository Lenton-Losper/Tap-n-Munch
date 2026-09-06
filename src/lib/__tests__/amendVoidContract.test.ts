/**
 * WHAT amendTabLines PUTS ON THE WIRE WHEN FOOD IS COMING OFF A BILL.
 *
 * voidApprovalRender.test.tsx proves the SHEET hands the approval to amendTabLines. It mocks that
 * function, so it says nothing about whether the approval reaches the server — a client that
 * accepted `extras` and built the old body would pass every test in that file and be refused with
 * VOID_NEEDS_AUTHORIZATION at a table. This suite is the other half: the real function, a fake
 * fetch, and the JSON that actually goes out.
 *
 * THE FIELD NAMES ARE THE SERVER'S. The route reads staff_user_id / authorization_token_id /
 * void_reason (it also accepts camelCase, which is not a reason to send a shape nobody reads).
 *
 * AN INCREASE MUST SEND NEITHER THE KEYS NOR NULLS. `staff_user_id: null` is not the same request
 * as no key at all, and a route that starts treating a present-but-empty field as an attempt to
 * authorise is a change nobody would notice here unless absence is asserted.
 */
import {withApi} from './helpers/apiHarness';

jest.mock('../storage', () => ({
  getRefreshToken: jest.fn(async () => 'refresh-token'),
  saveTerminalToken: jest.fn(async () => undefined),
  saveRefreshToken: jest.fn(async () => undefined),
  saveRestaurantId: jest.fn(async () => undefined),
  saveTerminalId: jest.fn(async () => undefined),
  saveRestaurantName: jest.fn(async () => undefined),
  saveMerchantCredentials: jest.fn(async () => undefined),
}));

const TAB = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const OK = {order_id: 'o1', order_number: 7, applied: [{line_id: LINE}], refused: []};

describe('amendTabLines — the wire contract', () => {
  it('sends the manager, the token and the reason on a void', async () => {
    await withApi({status: 200, body: OK}, async (api, calls) => {
      await api.amendTabLines(TAB, [{line_id: LINE, new_quantity: 1}], 'jwt', {
        staffUserId: 'mgr-1',
        authorizationTokenId: 'auth-token-1',
        voidReason: 'Sent back, overcooked',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`https://example.invalid/api/terminal/tabs/${TAB}/amend`);
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        amendments: [{line_id: LINE, new_quantity: 1}],
        staff_user_id: 'mgr-1',
        authorization_token_id: 'auth-token-1',
        void_reason: 'Sent back, overcooked',
      });
    });
  });

  it('sends the amendments alone on an increase — no keys, not even null ones', async () => {
    await withApi({status: 200, body: OK}, async (api, calls) => {
      await api.amendTabLines(TAB, [{line_id: LINE, new_quantity: 4}], 'jwt');

      const body = JSON.parse(String(calls[0].init.body));
      expect(body).toEqual({amendments: [{line_id: LINE, new_quantity: 4}]});
      expect(Object.keys(body)).toEqual(['amendments']);
    });
  });

  it('a void refusal does NOT read as an expired session', async () => {
    /**
     * terminalFetch evicts on a 401. If the route's 403 refusals reached that machinery the
     * terminal would sign itself out mid-service every time a PIN was mistyped. Asserted by
     * driving the real refusal through the real client and checking what comes back.
     */
    await withApi(
      {
        status: 403,
        body: {error: 'Authorization could not be verified', code: 'AUTHORIZATION_INVALID'},
      },
      async (api, calls) => {
        await expect(
          api.amendTabLines(TAB, [{line_id: LINE, new_quantity: 0}], 'jwt', {
            staffUserId: 'mgr-1',
            authorizationTokenId: 'auth-token-1',
            voidReason: 'Customer changed their mind',
          }),
        ).rejects.toMatchObject({code: 'AUTHORIZATION_INVALID'});

        // ONE request. A retry here would be the session machinery having taken it.
        expect(calls).toHaveLength(1);
      },
    );
  });
});
