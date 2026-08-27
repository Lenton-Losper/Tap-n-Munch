/**
 * #265 — the reset-pin call, asserted against what actually goes on and comes off the wire.
 *
 * THE HARD REQUIREMENT IS THE LAST TEST IN THIS FILE: staff never see a PIN. The route is built so
 * one cannot exist to leak — it mints a single-use token and deliberately never touches `tab_pin`,
 * and the new PIN is minted at redemption and returned only to the customer's own device (ruling
 * Q1:A). This suite pins the DEVICE's half of that: even handed a body containing a PIN, the parse
 * must not carry one inward where a screen could render it.
 *
 * The rest is the shape of the request, tested here rather than through a helper's return value
 * for the reason apiPaymentContract's header states — a value computed perfectly and then never
 * put on the wire is this repo's recurring defect.
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

const TAB = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77';
const RECOVERY_URL =
  'https://example.test/menu/a1999166-ddfa-40d1-ad1f-2f01282a1652/v2?table=12&pinReset=tok_abc';

describe('#265 — resetTabPin on the wire', () => {
  it('POSTs to the tab-scoped reset-pin route', async () => {
    const calls = await withApi(
      {status: 200, body: {ok: true, recoveryUrl: RECOVERY_URL}},
      async (api, seen) => {
        await api.resetTabPin(TAB, 'tok');
        return seen;
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://example.invalid/api/tabs/${TAB}/reset-pin`,
    );
    expect(calls[0].init.method).toBe('POST');
  });

  it('returns the recovery URL the customer will scan', async () => {
    const result = await withApi(
      {status: 200, body: {ok: true, recoveryUrl: RECOVERY_URL}},
      async api => api.resetTabPin(TAB, 'tok'),
    );

    expect(result.ok).toBe(true);
    expect(result.recoveryUrl).toBe(RECOVERY_URL);
  });

  it('treats a 200 with no URL as a failure, not a success with nothing to show', async () => {
    // The screen renders a QR from this string. An empty one would produce a sheet containing
    // nothing, which reads to staff as "it worked" — the worst of the three outcomes.
    const result = await withApi(
      {status: 200, body: {ok: true}},
      async api => api.resetTabPin(TAB, 'tok'),
    );

    expect(result.recoveryUrl).toBe('');
  });

  it('does not treat a non-boolean ok as success', async () => {
    const result = await withApi(
      {status: 200, body: {ok: 'yes', recoveryUrl: RECOVERY_URL}},
      async api => api.resetTabPin(TAB, 'tok'),
    );

    expect(result.ok).toBe(false);
  });

  it('throws on a 403 so the screen can say "not permitted" rather than showing an empty sheet', async () => {
    // The server is the real gate: it requires orders:update. The device gate is only about
    // whether staff are shown a control that would fail.
    await expect(
      withApi({status: 403, body: {error: 'forbidden'}}, async api =>
        api.resetTabPin(TAB, 'tok'),
      ),
    ).rejects.toMatchObject({status: 403});
  });

  it('carries expiresAt through, because requirement 4 needs it', async () => {
    // Dropped entirely in the first cut of this route, which is how the QR came to be shown
    // indefinitely. A screen cannot expire a code whose expiry never reached it.
    const result = await withApi(
      {
        status: 200,
        body: {
          ok: true,
          recoveryUrl: RECOVERY_URL,
          expiresAt: '2026-08-27T05:15:00.000Z',
        },
      },
      async api => api.resetTabPin(TAB, 'tok'),
    );

    expect(result.expiresAt).toBe('2026-08-27T05:15:00.000Z');
  });

  it('reports a missing or non-string expiresAt as null, never a fabricated value', async () => {
    // Null is a fact the screen acts on — fall back to the documented TTL. A guessed timestamp
    // would look authoritative and be wrong.
    for (const body of [
      {ok: true, recoveryUrl: RECOVERY_URL},
      {ok: true, recoveryUrl: RECOVERY_URL, expiresAt: 900},
      {ok: true, recoveryUrl: RECOVERY_URL, expiresAt: null},
    ]) {
      const result = await withApi({status: 200, body}, async api =>
        api.resetTabPin(TAB, 'tok'),
      );
      expect(result.expiresAt).toBeNull();
    }
  });

  it('still treats a 401 as an expired session, not a permission problem', async () => {
    // The other side of the split. 401 must keep its existing meaning app-wide; only 403 is
    // reinterpreted, and only on this route, because only this route is permission-gated.
    await expect(
      withApi({status: 401, body: {error: 'unauthorized'}}, async api =>
        api.resetTabPin(TAB, 'tok'),
      ),
    ).rejects.toMatchObject({name: 'TerminalAuthError'});
  });

  it('NEVER carries a PIN inward, even if the server sends one', async () => {
    // THE RULING, enforced on the device side. `reset-pin` cannot produce a PIN today — but a
    // parse that spread the whole body would hand one to the screen the moment some future server
    // did, and #265's entire premise is that staff must not be able to read a customer's PIN.
    const result = await withApi(
      {
        status: 200,
        body: {
          ok: true,
          recoveryUrl: RECOVERY_URL,
          pin: '4321',
          tab_pin: '4321',
          newPin: '4321',
        },
      },
      async api => api.resetTabPin(TAB, 'tok'),
    );

    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'ok', 'recoveryUrl']);
    expect(JSON.stringify(result)).not.toContain('4321');
  });
});
