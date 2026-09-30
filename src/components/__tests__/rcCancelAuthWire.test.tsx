/**
 * RC SPRINT 2026-09-30 — B (cancellation) and I (manager authorization), END TO END ON THE DEVICE.
 *
 * The REAL AmendLineSheet, the REAL VoidApproval, the REAL lib/api.ts amendTabLines /
 * authorizeTerminalAction / getAuthorizedUsers / refreshAccessToken. Only fetch and the native
 * token store are faked. amendSheetOutcomes.test.tsx covers the same sheet with the api mocked;
 * here what is measured is what reaches the wire -- how many /authorize POSTs one press makes, and
 * therefore how many lockout strikes the server records.
 *
 * THE FAKE SERVER FOLLOWS THE REAL ROUTES (web 5d6f2bc4):
 *   /api/terminal/authorize (app/api/terminal/authorize/route.ts)
 *     terminal JWT first (401, no code) -> lockout (429 PIN_LOCKED, no strike) -> membership /
 *     permission (403, no strike) -> PIN (401 PIN_MISMATCH + attempts_remaining, ONE strike; the
 *     strike that reaches 5 answers 429 PIN_LOCKED) -> 200 {token_id, expires_at}.
 *     Strikes are the lib/terminal-auth/pin-lockout.ts count: denied pin_mismatch events in the
 *     window. A correct PIN does NOT reset them.
 *   /api/terminal/tabs/:tabId/amend (…/amend/route.ts)
 *     a void needs a single-use line_void token for the named staff member (403
 *     AUTHORIZATION_INVALID otherwise); 200 {success, changed, order_id, applied, refused, lines}.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

import AmendLineSheet from '../AmendLineSheet';
import type {TabLine} from '../../lib/tabLines';
import * as Copy from '../../constants/amendCopy';
import {VOID_REFUSED_PIN} from '../../constants/voidCopy';

const MGR = '6f1c1a2e-0000-4000-8000-00000000a001';
const WAITER = '6f1c1a2e-0000-4000-8000-00000000b002';
const RIGHT_PIN = '4321';
const TAB = 'c4a05000-0000-4000-8000-0000000000aa';

// ------------------------------------------------------------------------------------------------
// THE FAKE SERVER
// ------------------------------------------------------------------------------------------------
type Hit = {path: string; bearer: string | null; body: Record<string, unknown> | null};
let hits: Hit[] = [];
let strikes: Record<string, number> = {};
let issued: Map<string, {user: string; used: boolean}>;
let voided: Set<string>;
let validBearers: Set<string>;
let refreshWorks = true;
let refreshes = 0;
/** What /amend does with the next request. */
let amendMode:
  | 'apply'
  | 'refuse:window_closed'
  | 'refuse:order_paid'
  | 'refuse:line_settled'
  | 'empty'
  | 'malformed'
  | 'not-json'
  | '502'
  | '500'
  | 'apply-then-drop' = 'apply';

function res(status: number, body: unknown, raw?: string): Response {
  const text = raw ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => 'application/json'},
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function authorizeRoute(body: Record<string, unknown>): Response {
  const user = String(body.user_id);
  const pin = String(body.pin);
  const count = strikes[user] ?? 0;
  if (count >= 5) {
    return res(429, {
      error: 'PIN temporarily locked after too many failed attempts',
      code: 'PIN_LOCKED',
      retry_after_seconds: 600,
      max_attempts: 5,
    });
  }
  if (user !== MGR) {
    // A member without the permission: denied, and NOT a PIN strike.
    return res(403, {error: 'Authorization denied'});
  }
  if (pin !== RIGHT_PIN) {
    strikes[user] = count + 1;
    const locked = strikes[user] >= 5;
    return res(locked ? 429 : 401, {
      error: 'Invalid PIN',
      code: locked ? 'PIN_LOCKED' : 'PIN_MISMATCH',
      attempts_remaining: Math.max(0, 5 - strikes[user]),
      ...(locked ? {retry_after_seconds: 600} : {}),
    });
  }
  const token_id = `auth-${issued.size + 1}`;
  issued.set(token_id, {user, used: false});
  return res(200, {token_id, expires_at: '2026-09-30T12:01:30.000Z'});
}

function amendRoute(body: Record<string, unknown>): Response | 'drop' {
  const amendments = body.amendments as Array<{line_id: string; new_quantity: number}>;
  const reduces = amendments.some(a => a.new_quantity < 1);
  if (reduces) {
    const tok = issued.get(String(body.authorization_token_id ?? ''));
    if (!tok || tok.used || tok.user !== body.staff_user_id) {
      return res(403, {error: 'Authorization could not be verified', code: 'AUTHORIZATION_INVALID'});
    }
    tok.used = true;
  }
  const lineId = amendments[0].line_id;
  switch (amendMode) {
    case '502':
      return res(502, {error: 'Could not apply this amendment', code: 'AMEND_FAILED'});
    case '500':
      return res(500, {error: 'Failed to amend the tab'});
    case 'empty':
      return res(200, {success: true, changed: false, order_id: null, applied: [], refused: []});
    case 'malformed':
      return res(200, {success: true});
    case 'not-json':
      return res(200, null, '<html>gateway</html>');
    case 'refuse:window_closed':
    case 'refuse:order_paid':
    case 'refuse:line_settled':
      return res(200, {
        success: true,
        changed: false,
        order_id: null,
        applied: [],
        refused: [{line_id: lineId, reason: amendMode.slice('refuse:'.length)}],
      });
    default: {
      if (voided.has(lineId)) {
        return res(200, {success: true, changed: false, order_id: null, applied: [], refused: [{line_id: lineId, reason: 'not_found'}]});
      }
      voided.add(lineId);
      const ok = res(200, {
        success: true,
        changed: true,
        order_id: null,
        order_number: null,
        applied: [{line_id: lineId, action: 'voided'}],
        refused: [],
        lines: [{line_id: lineId, name: 'Modena Pasta', outcome: 'voided', previous_quantity: 1, quantity: 0}],
      });
      return amendMode === 'apply-then-drop' ? 'drop' : ok;
    }
  }
}

function installServer() {
  (globalThis as unknown as {fetch: unknown}).fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers.Authorization ? headers.Authorization.replace(/^Bearer /, '') : null;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    hits.push({path: url.pathname, bearer, body});

    if (url.pathname === '/api/terminal/refresh') {
      if (!refreshWorks) {
        return res(401, {error: 'Unauthorized'});
      }
      refreshes += 1;
      const fresh = `tok-fresh-${refreshes}`;
      validBearers.add(fresh);
      return res(200, {accessToken: fresh, refreshToken: `refresh-${refreshes + 1}`});
    }
    // requireTerminalAuth runs FIRST on every terminal route, before anything is counted.
    if (!bearer || !validBearers.has(bearer)) {
      return res(401, {error: 'Unauthorized'});
    }
    if (url.pathname === '/api/terminal/authorized-users') {
      return res(200, {
        users: [
          {user_id: MGR, name: 'Lenton'},
          // A stale picker: the waiter still listed. The SERVER is what refuses them.
          {user_id: WAITER, name: 'Sam'},
        ],
      });
    }
    if (url.pathname === '/api/terminal/authorize') {
      return authorizeRoute(body ?? {});
    }
    if (url.pathname === `/api/terminal/tabs/${TAB}/amend`) {
      const out = amendRoute(body ?? {});
      if (out === 'drop') {
        throw new TypeError('Network request failed');
      }
      return out;
    }
    return res(404, {error: `unrouted ${url.pathname}`});
  };
}

const authorizePosts = () => hits.filter(h => h.path === '/api/terminal/authorize');
const amendPosts = () => hits.filter(h => h.path === `/api/terminal/tabs/${TAB}/amend`);

// ------------------------------------------------------------------------------------------------
// THE SHEET
// ------------------------------------------------------------------------------------------------
const tokenStore = new Map<string, string>();
beforeAll(() => {
  const encrypted = require('react-native-encrypted-storage').default as Record<string, jest.Mock>;
  encrypted.getItem.mockImplementation(async (k: string) => tokenStore.get(k) ?? null);
  encrypted.setItem.mockImplementation(async (k: string, v: string) => {
    tokenStore.set(k, v);
  });
  encrypted.removeItem.mockImplementation(async (k: string) => {
    tokenStore.delete(k);
  });
});

beforeEach(() => {
  hits = [];
  strikes = {};
  issued = new Map();
  voided = new Set();
  validBearers = new Set(['tok-valid']);
  refreshWorks = true;
  refreshes = 0;
  amendMode = 'apply';
  tokenStore.clear();
  tokenStore.set('flashtap_terminal_token', 'tok-valid');
  tokenStore.set('flashtap_refresh_token', 'refresh-1');
  installServer();
});

function line(over: Partial<TabLine> = {}): TabLine {
  return {
    id: 'l-modena',
    name_snapshot: 'Modena Pasta',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    total_cents: 24000,
    ...over,
  } as TabLine;
}

type Mounted = {tree: renderer.ReactTestRenderer; onRefetch: jest.Mock; onClose: jest.Mock};
async function mount(l: TabLine = line()): Promise<Mounted> {
  const onRefetch = jest.fn();
  const onClose = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <AmendLineSheet tabId={TAB} line={l} onClose={onClose} onRefetch={onRefetch} />,
    );
  });
  await flush();
  return {tree, onRefetch, onClose};
}
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
const byId = (tree: renderer.ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.findByProps({testID: id});
const has = (tree: renderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({testID: id}).length > 0;
const allText = (tree: renderer.ReactTestRenderer): string =>
  tree.root
    .findAllByType(Text)
    .map(t => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    })
    .join(' | ');
const press = async (node: ReactTestInstance) => {
  await act(async () => {
    await node.props.onPress();
  });
  await flush();
};
const type = async (node: ReactTestInstance, text: string) => {
  await act(async () => {
    node.props.onChangeText(text);
  });
};

/** Take the item off with `who` approving under `pin`, as the waiter does it. */
async function removeWith(m: Mounted, who: string, pin: string, opts: {stepDown?: boolean} = {}) {
  if (opts.stepDown !== false && has(m.tree, 'amend-minus')) {
    await press(byId(m.tree, 'amend-minus'));
  }
  await press(byId(m.tree, `void-manager-${who}`));
  await type(byId(m.tree, 'void-pin'), pin);
  await type(byId(m.tree, 'void-reason'), 'Customer changed their mind');
  await press(byId(m.tree, 'amend-confirm'));
}
/** Another try on the same open sheet after a refusal: the quantity is already 0. */
async function tryAgain(m: Mounted, who: string, pin: string) {
  await removeWith(m, who, pin, {stepDown: false});
}

// ================================================================================================
describe('I — manager authorization', () => {
  it('I1 MUTATION GUARD (no double strike): one wrong PIN is ONE /authorize POST and ONE strike; nothing is amended', async () => {
    const m = await mount();
    await removeWith(m, MGR, '0000');

    expect(authorizePosts()).toHaveLength(1);
    expect(strikes[MGR]).toBe(1);
    expect(amendPosts()).toHaveLength(0);
    const failure = byId(m.tree, 'amend-failure').props.children as string;
    expect(failure).toContain(VOID_REFUSED_PIN);
    expect(failure).toContain('4 tries left');
    expect(failure).not.toMatch(/signed in|session/i);
    expect(byId(m.tree, 'void-pin').props.value).toBe('');
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
  });

  it('I1 with an expired terminal session at the same moment: refresh once, re-POST once -> still ONE strike', async () => {
    const m = await mount();
    expect(has(m.tree, `void-manager-${MGR}`)).toBe(false); // picker loads once a void is chosen
    await press(byId(m.tree, 'amend-minus'));
    expect(has(m.tree, `void-manager-${MGR}`)).toBe(true);
    // The terminal's access token expires now, between the picker read and the PIN post.
    validBearers = new Set();
    await removeWith(m, MGR, '0000', {stepDown: false});

    const posts = authorizePosts();
    expect(posts).toHaveLength(2);
    expect(posts[0].bearer).toBe('tok-valid');
    expect(posts[1].bearer).toBe('tok-fresh-1');
    // The first POST was refused at the terminal check, before any PIN was looked at.
    expect(strikes[MGR]).toBe(1);
    expect(amendPosts()).toHaveLength(0);
  });

  it('I2: five wrong PINs are five strikes; the fifth locks; a sixth try is refused WITHOUT a strike and says so', async () => {
    const m = await mount();
    await removeWith(m, MGR, '0000');
    for (let i = 2; i <= 5; i += 1) {
      await tryAgain(m, MGR, '0000');
      expect(strikes[MGR]).toBe(i);
    }
    expect(authorizePosts()).toHaveLength(5);
    const lockedCopy = byId(m.tree, 'amend-failure').props.children as string;
    expect(lockedCopy).toMatch(/Nothing came off the bill/);
    expect(lockedCopy).not.toMatch(/signed in|session/i);

    // Even the RIGHT PIN is refused while locked, and costs nothing.
    await tryAgain(m, MGR, RIGHT_PIN);
    expect(authorizePosts()).toHaveLength(6);
    expect(strikes[MGR]).toBe(5);
    expect(amendPosts()).toHaveLength(0);
    expect(voided.size).toBe(0);
  });

  it('I3: the correct PIN after two wrong ones is accepted, the token is spent by the ONE amend, and it is said', async () => {
    const m = await mount();
    await removeWith(m, MGR, '1111');
    await tryAgain(m, MGR, '2222');
    await tryAgain(m, MGR, RIGHT_PIN);

    expect(strikes[MGR]).toBe(2); // the server does not reset on success (pin-lockout.ts)
    expect(amendPosts()).toHaveLength(1);
    expect(amendPosts()[0].body).toMatchObject({
      staff_user_id: MGR,
      authorization_token_id: 'auth-1',
      void_reason: 'Customer changed their mind',
    });
    expect(issued.get('auth-1')?.used).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Modena Pasta removed — N$240.00 off the bill.',
    );
  });

  it('I4: an expired terminal session that cannot be refreshed says "not signed in", never "wrong PIN", and costs no strike', async () => {
    const m = await mount();
    await press(byId(m.tree, 'amend-minus'));
    // The session dies after the picker loaded and before the PIN is checked, and cannot be renewed.
    validBearers = new Set();
    refreshWorks = false;
    await removeWith(m, MGR, RIGHT_PIN, {stepDown: false});

    expect(byId(m.tree, 'amend-failure').props.children).toBe(Copy.AMEND_NO_SESSION);
    expect(strikes[MGR]).toBeUndefined();
    expect(amendPosts()).toHaveLength(0);
  });

  it('I5: a waiter without the permission is refused by the SERVER, no strike, nothing amended', async () => {
    const m = await mount();
    await removeWith(m, WAITER, '9999');

    expect(authorizePosts()).toHaveLength(1);
    expect(strikes[WAITER]).toBeUndefined();
    expect(amendPosts()).toHaveLength(0);
    expect(byId(m.tree, 'amend-failure').props.children).toBe(Copy.AMEND_AUTHORIZE_DENIED);
  });

  it('I6: an authorised manager removes the item: one /authorize, one /amend carrying that token, success said with the money', async () => {
    const m = await mount();
    await removeWith(m, MGR, RIGHT_PIN);
    expect(authorizePosts()).toHaveLength(1);
    expect(amendPosts()).toHaveLength(1);
    expect(amendPosts()[0].body?.authorization_token_id).toBe('auth-1');
    expect(voided.has('l-modena')).toBe(true);
    expect(has(m.tree, 'amend-verdict-success')).toBe(true);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });

  it('a double press on Approve is one /authorize and one /amend', async () => {
    const m = await mount();
    await press(byId(m.tree, 'amend-minus'));
    await press(byId(m.tree, `void-manager-${MGR}`));
    await type(byId(m.tree, 'void-pin'), RIGHT_PIN);
    await type(byId(m.tree, 'void-reason'), 'Customer changed their mind');
    const confirm = byId(m.tree, 'amend-confirm');
    await act(async () => {
      void confirm.props.onPress();
      void confirm.props.onPress();
      await Promise.resolve();
    });
    await flush();
    expect(authorizePosts()).toHaveLength(1);
    expect(amendPosts()).toHaveLength(1);
  });
});

describe('B — cancellation outcomes over the wire', () => {
  it('B2: the server voided it but the answer was lost -> NOT confirmed, tab re-read; the retry is answered by the server truth', async () => {
    amendMode = 'apply-then-drop';
    const m = await mount();
    await removeWith(m, MGR, RIGHT_PIN);
    expect(voided.has('l-modena')).toBe(true); // it DID come off
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(Copy.AMEND_NOT_CONFIRMED_TITLE);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);

    // The re-read shows the truth: the line is voided, and the sheet says so rather than offering it again.
    await act(async () => {
      m.tree.update(
        <AmendLineSheet
          tabId={TAB}
          line={line({is_voided: true})}
          onClose={m.onClose}
          onRefetch={m.onRefetch}
        />,
      );
    });
    await flush();
    expect(has(m.tree, 'amend-already-voided')).toBe(true);
    expect(has(m.tree, 'amend-confirm')).toBe(false);
  });

  it.each([
    ['B3 a malformed 200', 'malformed'],
    ['B3 a 200 that is not JSON', 'not-json'],
    ['B4 HTTP 502', '502'],
    ['B4 HTTP 500', '500'],
    ['B5 200 with applied: []', 'empty'],
  ] as const)('%s is NEVER success: NOT confirmed, and the tab is re-read', async (_label, mode) => {
    amendMode = mode;
    const m = await mount();
    await removeWith(m, MGR, RIGHT_PIN);
    expect(amendPosts()).toHaveLength(1);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(has(m.tree, 'amend-verdict-unknown')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(Copy.AMEND_NOT_CONFIRMED_TITLE);
    expect(allText(m.tree)).not.toMatch(/removed —/);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
    expect(m.onClose).not.toHaveBeenCalled();
  });

  it('B6: a line the kitchen has cooked opens to "cannot be cancelled here" and posts nothing', async () => {
    const m = await mount(line({kitchen_state: 'cooked'}));
    expect(has(m.tree, 'amend-window-closed')).toBe(true);
    expect(allText(m.tree)).toContain('Nothing has been removed');
    expect(has(m.tree, 'amend-confirm')).toBe(false);
    expect(hits.filter(h => h.path !== '/api/terminal/authorized-users')).toHaveLength(0);
  });

  it.each([
    ['B6 cooked between render and press', 'refuse:window_closed', /Already cooked — NOT removed/],
    ['B7 order already paid', 'refuse:order_paid', /already paid — NOT removed/],
    ['B7 line already settled', 'refuse:line_settled', /already been paid for — NOT removed/],
  ] as const)('%s: refusal names the reason and says NOT removed', async (_label, mode, pattern) => {
    amendMode = mode;
    const m = await mount();
    await removeWith(m, MGR, RIGHT_PIN);
    expect(has(m.tree, 'amend-verdict-refused')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe('Modena Pasta was NOT removed');
    expect(byId(m.tree, 'amend-verdict-body').props.children).toMatch(pattern);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
  });
});
