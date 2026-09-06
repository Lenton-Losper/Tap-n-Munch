/**
 * WHAT getCashUpReport PUTS ON THE WIRE.
 *
 * cashUpPrinting.test.ts mocks this function, so it says nothing about the body that actually
 * goes out. A client that accepted the token and then posted without it would pass every test in
 * that file and be refused with CASH_UP_NEEDS_AUTHORIZATION at a counter.
 *
 * THE FIELD NAMES ARE THE SERVER'S: preset / staff_user_id / authorization_token_id.
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

const OK = {
  period: {preset: 'today', label: 'Today', startDate: '2026-09-07', endDate: '2026-09-07', timezone: 'Africa/Windhoek'},
  summary: {
    paymentMethodSplit: [{method: 'cash', orders: 3, gross: 90}],
    totalRevenue: 90,
    totalOrders: 3,
    refundedTotal: 0,
    itemsSold: [{name: 'Coffee', quantity: 3, gross: 90}],
    gratuityTotal: null,
    gratuityCount: null,
  },
  escposBase64: 'QkFTRTY0',
  sdk6Lines: [{type: 'text', text: 'CASH-UP', align: 'center'}],
};

const PARAMS = {
  preset: 'yesterday' as const,
  staffUserId: 'mgr-1',
  authorizationTokenId: 'auth-1',
  characterWidth: 48,
};

describe('getCashUpReport — the wire contract', () => {
  it('sends the preset, the manager and the consumed token', async () => {
    await withApi({status: 200, body: OK}, async (api, calls) => {
      await api.getCashUpReport(PARAMS, 'jwt');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://example.invalid/api/terminal/reports/cash-up');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        preset: 'yesterday',
        staff_user_id: 'mgr-1',
        authorization_token_id: 'auth-1',
        character_width: 48,
      });
    });
  });

  it('omits the width when the terminal has none stored, rather than sending a zero', async () => {
    // A zero would be a claim about the paper. Absent lets the server use its own default.
    await withApi({status: 200, body: OK}, async (api, calls) => {
      await api.getCashUpReport({...PARAMS, characterWidth: null}, 'jwt');
      const body = JSON.parse(String(calls[0].init.body));
      expect('character_width' in body).toBe(false);
    });
  });

  it('refuses a response missing a printable format rather than failing at the printer', async () => {
    await withApi({status: 200, body: {...OK, escposBase64: undefined}}, async (api) => {
      await expect(api.getCashUpReport(PARAMS, 'jwt')).rejects.toThrow(/printable format/i);
    });
  });

  it('a refused PIN does NOT read as an expired session', async () => {
    /**
     * terminalFetch evicts on a 401. If the route's 403 reached that machinery, a mistyped PIN
     * would sign the terminal out in the middle of closing up. One request, and a coded error.
     */
    await withApi(
      {status: 403, body: {error: 'no', code: 'AUTHORIZATION_INVALID'}},
      async (api, calls) => {
        await expect(api.getCashUpReport(PARAMS, 'jwt')).rejects.toMatchObject({
          code: 'AUTHORIZATION_INVALID',
        });
        expect(calls).toHaveLength(1);
      },
    );
  });
});
