/**
 * WHAT THE WAITER IS TOLD AFTER PRESSING "TAKE IT OFF". (Sprint 2026-09-28 brief — Riviera #160.)
 *
 * The sheet used to signal success ONLY by closing, which looked the same as "Leave it as it is",
 * the back button, or walking away mid-PIN; and a 200 without the line in `applied` closed it too.
 * These mount the real sheet with the api mocked and read what a waiter would see.
 *
 * MUTATION GUARDS (brief section E):
 *   (a) "treats the sheet closing / a 200 with the line absent from applied as success"
 *       -> 'a 200 that does not mention the line is NOT success, and the sheet stays open'
 *   (b) "shows the line as cancelled without server confirmation (optimistic)"
 *       -> 'nothing reads as removed while the request is in flight'
 *   Both were run against a deliberately broken sheet; see the sprint report for the record.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

const mockAmend = jest.fn();
const mockAuthorize = jest.fn();
const mockGetAuthorizedUsers = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    amendTabLines: (...a: unknown[]) => mockAmend(...a),
    authorizeTerminalAction: (...a: unknown[]) => mockAuthorize(...a),
    getAuthorizedUsers: (...a: unknown[]) => mockGetAuthorizedUsers(...a),
  };
});

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

import AmendLineSheet from '../AmendLineSheet';
import type {TabLine} from '../../lib/tabLines';
import {parseAmendResult} from '../../lib/amendTabLines';
import * as Copy from '../../constants/amendCopy';
import {VOID_REFUSED_PIN} from '../../constants/voidCopy';

const {ApiRequestError, RequestOutcomeUnknownError, TerminalAuthError} = jest.requireActual(
  '../../lib/api',
);

function tabLine(over: Partial<TabLine> & {id: string; name_snapshot: string}): TabLine {
  return {
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    ...over,
  } as TabLine;
}

const MODENA = tabLine({id: 'l-modena', name_snapshot: 'Modena Pasta', total_cents: 24000});

// ── harness ──────────────────────────────────────────────────────────────────

type Mounted = {
  tree: renderer.ReactTestRenderer;
  onClose: jest.Mock;
  onRefetch: jest.Mock;
  setLine: (line: TabLine | null) => Promise<void>;
};

async function mount(line: TabLine): Promise<Mounted> {
  const onClose = jest.fn();
  const onRefetch = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  const render = (l: TabLine | null) => (
    <AmendLineSheet tabId="tab-1" line={l} onClose={onClose} onRefetch={onRefetch} />
  );
  await act(async () => {
    tree = renderer.create(render(line));
  });
  return {
    tree,
    onClose,
    onRefetch,
    setLine: async l => {
      await act(async () => {
        tree.update(render(l));
      });
    },
  };
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
    node.props.onPress();
  });
};
const type = async (node: ReactTestInstance, text: string) => {
  await act(async () => {
    node.props.onChangeText(text);
  });
};

/** Remove the line (quantity to 0) with a complete manager approval, and press Approve. */
async function removeWithApproval(m: Mounted, from = 1, to = 0, pin = '1234') {
  for (let q = from; q > to; q -= 1) {
    await press(byId(m.tree, 'amend-minus'));
  }
  await press(byId(m.tree, 'void-manager-mgr-1'));
  await type(byId(m.tree, 'void-pin'), pin);
  await type(byId(m.tree, 'void-reason'), 'Customer changed their mind');
  await press(byId(m.tree, 'amend-confirm'));
}

/** The Modal's hardware-back handler. */
const hardwareBack = async (tree: renderer.ReactTestRenderer) => {
  const modal = tree.root.findAll(n => typeof n.props.onRequestClose === 'function')[0];
  await act(async () => {
    modal.props.onRequestClose();
  });
};

const applied = (lineId: string, action: 'voided' | 'replaced' = 'voided') =>
  parseAmendResult({applied: [{line_id: lineId, action}], refused: []});
const refused = (lineId: string, reason: string) =>
  parseAmendResult({applied: [], refused: [{line_id: lineId, reason}]});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({token_id: 'auth-1', expires_at: 'x'});
  mockGetAuthorizedUsers.mockResolvedValue([{user_id: 'mgr-1', name: 'Lenton'}]);
});

// ── outcomes ─────────────────────────────────────────────────────────────────

describe('a successful cancellation is SAID, with the money', () => {
  it('shows "Modena Pasta removed — N$240.00 off the bill", keeps the sheet open, re-reads the tab', async () => {
    mockAmend.mockResolvedValue(applied(MODENA.id));
    const m = await mount(MODENA);
    await removeWithApproval(m);

    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Modena Pasta removed — N$240.00 off the bill.',
    );
    expect(has(m.tree, 'amend-verdict-success')).toBe(true);
    // Success is no longer signalled by closing.
    expect(m.onClose).not.toHaveBeenCalled();
    expect(m.onRefetch).toHaveBeenCalledTimes(1);

    await press(byId(m.tree, 'amend-dismiss'));
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it('a reduction says what it was reduced to', async () => {
    const burger = tabLine({id: 'l-burger', name_snapshot: 'Beef Burger', quantity: 3, total_cents: 36000});
    mockAmend.mockResolvedValue(applied(burger.id, 'replaced'));
    const m = await mount(burger);
    await removeWithApproval(m, 3, 1);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Beef Burger reduced to 1 — N$240.00 off the bill.',
    );
  });
});

describe('MUTATION GUARD (a): closing / a silent 200 is never success', () => {
  it('a 200 that does not mention the line is NOT success, and the sheet stays open', async () => {
    mockAmend.mockResolvedValue(parseAmendResult({applied: [], refused: []}));
    const m = await mount(MODENA);
    await removeWithApproval(m);

    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(has(m.tree, 'amend-verdict-unknown')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Cancellation NOT confirmed — check the table',
    );
    expect(m.onClose).not.toHaveBeenCalled();
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });

  it('PARTIAL: another line applied does not confirm this one', async () => {
    mockAmend.mockResolvedValue(applied('some-other-line'));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(has(m.tree, 'amend-verdict-unknown')).toBe(true);
  });

  it('a malformed 200 is NOT success', async () => {
    mockAmend.mockResolvedValue(parseAmendResult({success: true}));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(has(m.tree, 'amend-verdict-unknown')).toBe(true);
    expect(m.onClose).not.toHaveBeenCalled();
  });
});

describe('MUTATION GUARD (b): nothing is shown as cancelled before the server says so', () => {
  it('nothing reads as removed while the request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    mockAmend.mockReturnValue(new Promise(r => (resolve = r)));
    const m = await mount(MODENA);
    await removeWithApproval(m);

    // In flight: no verdict of any kind, and no word "removed" anywhere on the sheet.
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(allText(m.tree)).not.toMatch(/removed —/);
    expect(m.onRefetch).not.toHaveBeenCalled();

    // The server's answer, and only it, makes it true.
    await act(async () => {
      resolve(applied(MODENA.id));
    });
    expect(has(m.tree, 'amend-verdict-success')).toBe(true);
  });
});

describe('refusals name the reason and say NOT removed', () => {
  it.each([
    ['window_closed', /Already cooked — NOT removed/],
    ['order_paid', /already paid — NOT removed/],
    ['line_settled', /already been paid for — NOT removed/],
    ['not_found', /not found on the tab/],
    ['invalid_quantity', /NOT changed/],
  ])('%s', async (reason, pattern) => {
    mockAmend.mockResolvedValue(refused(MODENA.id, reason));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-refused')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe('Modena Pasta was NOT removed');
    expect(byId(m.tree, 'amend-verdict-body').props.children).toMatch(pattern);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });

  it('every refusal string says it is still on the bill or points at the table', () => {
    for (const text of Object.values(Copy.AMEND_REFUSAL_REASON)) {
      expect(text).toMatch(/still on the bill|check the table/i);
    }
  });
});

describe('failures with no answer are NOT confirmed — never success, never "nothing changed"', () => {
  it.each([
    ['a network failure', () => new RequestOutcomeUnknownError('network')],
    ['a timeout', () => new RequestOutcomeUnknownError('timeout')],
    ['a 502 AMEND_FAILED', () => new ApiRequestError('x', 502, {code: 'AMEND_FAILED'})],
    ['a 500', () => new ApiRequestError('boom', 500)],
    ['something unrecognised', () => new Error('???')],
  ])('%s', async (_label, make) => {
    mockAmend.mockRejectedValue(make());
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-unknown')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Cancellation NOT confirmed — check the table',
    );
    expect(allText(m.tree)).not.toMatch(/nothing on the order was altered/);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
    expect(m.onClose).not.toHaveBeenCalled();
  });
});

describe('authorization failures are handled here, in the right words', () => {
  it('a WRONG PIN says the PIN was not accepted — not "session expired" — and amends nothing', async () => {
    mockAuthorize.mockRejectedValue(
      new ApiRequestError('That PIN was not accepted.', 401, {code: 'PIN_MISMATCH', attemptsRemaining: 2}),
    );
    const m = await mount(MODENA);
    await removeWithApproval(m, 1, 0, '0000');
    expect(mockAmend).not.toHaveBeenCalled();
    const failure = byId(m.tree, 'amend-failure').props.children as string;
    expect(failure).toContain(VOID_REFUSED_PIN);
    expect(failure).toContain('2 tries left');
    expect(failure).not.toMatch(/session/i);
    expect(byId(m.tree, 'void-pin').props.value).toBe('');
  });

  it('NO PERMISSION says this person cannot approve it', async () => {
    mockAuthorize.mockRejectedValue(
      new ApiRequestError('This person cannot approve this here.', 403, {code: 'AUTHORIZATION_DENIED'}),
    );
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(mockAmend).not.toHaveBeenCalled();
    expect(byId(m.tree, 'amend-failure').props.children).toBe(Copy.AMEND_AUTHORIZE_DENIED);
  });

  it('a PIN check that never answered says nothing came off (the amend was never sent)', async () => {
    mockAuthorize.mockRejectedValue(new RequestOutcomeUnknownError('timeout'));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(mockAmend).not.toHaveBeenCalled();
    expect(byId(m.tree, 'amend-failure').props.children).toBe(Copy.AMEND_AUTHORIZE_UNREACHABLE);
  });

  it('only a REAL session failure says the terminal is signed out', async () => {
    mockAuthorize.mockRejectedValue(new TerminalAuthError());
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(byId(m.tree, 'amend-failure').props.children).toBe(Copy.AMEND_NO_SESSION);
  });
});

describe('the sheet cannot be dismissed mid-request, and a late answer is dropped', () => {
  it('back button and Leave-it do nothing while busy', async () => {
    let resolve!: (v: unknown) => void;
    mockAmend.mockReturnValue(new Promise(r => (resolve = r)));
    const m = await mount(MODENA);
    await removeWithApproval(m);

    await hardwareBack(m.tree);
    expect(m.onClose).not.toHaveBeenCalled();
    expect(byId(m.tree, 'amend-cancel').props.disabled).toBe(true);

    await act(async () => {
      resolve(applied(MODENA.id));
    });
    // Now it may close.
    await hardwareBack(m.tree);
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it('torn down mid-request: the tab is re-read, and the late answer paints nothing', async () => {
    let resolve!: (v: unknown) => void;
    mockAmend.mockReturnValue(new Promise(r => (resolve = r)));
    const m = await mount(MODENA);
    await removeWithApproval(m);

    const other = tabLine({id: 'l-salmon', name_snapshot: 'Grilled Salmon'});
    await m.setLine(other);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(applied(MODENA.id));
    });
    // The Salmon sheet must not announce the Modena's result.
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(allText(m.tree)).not.toMatch(/Modena/);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });
});

describe('cooked and already-cancelled lines answer, and remove nothing', () => {
  it('a cooked line says it cannot be cancelled here and that nothing was removed', async () => {
    const m = await mount({...MODENA, kitchen_state: 'cooked', is_cooked: true});
    const text = byId(m.tree, 'amend-window-closed').props.children as string;
    expect(text).toMatch(/cannot be cancelled from here/);
    expect(text).toMatch(/Nothing has been removed/);
    expect(text).toMatch(/still on the bill/);
    expect(text).not.toMatch(/tell them yourself/i);
    expect(has(m.tree, 'amend-confirm')).toBe(false);
  });

  it('an already-voided line says so and offers nothing', async () => {
    const m = await mount({...MODENA, is_voided: true});
    expect(has(m.tree, 'amend-already-voided')).toBe(true);
    expect(has(m.tree, 'amend-confirm')).toBe(false);
  });
});

// ── RIVIERA TABLE 1, permanently ────────────────────────────────────────────

/**
 * THE INCIDENT AS A SCENARIO. Three reductions that worked, each confirmed ONLY through `applied`;
 * then the Modena Pasta attempt in the four ways it can end. What the waiter sees each time is the
 * assertion. If any Modena variant other than the first ever reads "removed", #160 is back.
 */
describe('Riviera Table 1 — order #160', () => {
  const WYWH = tabLine({id: 'l-wywh', name_snapshot: 'WYWH', route_to: 'bar', kitchen_state: null, bar_state: 'outstanding', quantity: 2, total_cents: 19000});
  const BURGER = tabLine({id: 'l-burger', name_snapshot: 'Riviera Burger', quantity: 2, total_cents: 31000});
  const SALMON = tabLine({id: 'l-salmon', name_snapshot: 'Grilled Salmon', quantity: 1, total_cents: 28500});

  it.each([
    [WYWH, 2, 1, 'WYWH reduced to 1 — N$95.00 off the bill.', 'replaced' as const],
    [BURGER, 2, 1, 'Riviera Burger reduced to 1 — N$155.00 off the bill.', 'replaced' as const],
    [SALMON, 1, 0, 'Grilled Salmon removed — N$285.00 off the bill.', 'voided' as const],
  ])('reduction of %#: confirmed only via applied', async (line, from, to, said, action) => {
    mockAmend.mockResolvedValue(applied(line.id, action));
    const m = await mount(line);
    await removeWithApproval(m, from, to);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(said);
    expect(mockAmend.mock.calls[0][1]).toEqual([{line_id: line.id, new_quantity: to}]);
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });

  it('Modena, SUCCESS: "Modena Pasta removed — N$240.00 off the bill."', async () => {
    mockAmend.mockResolvedValue(applied(MODENA.id));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(true);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Modena Pasta removed — N$240.00 off the bill.',
    );
  });

  it('Modena, REFUSED window_closed: "already cooked — NOT removed, still on the bill"', async () => {
    mockAmend.mockResolvedValue(refused(MODENA.id, 'window_closed'));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe('Modena Pasta was NOT removed');
    expect(byId(m.tree, 'amend-verdict-body').props.children).toBe(
      'Already cooked — NOT removed. It is being made and it is still on the bill.',
    );
  });

  it('Modena, TIMEOUT: "Cancellation NOT confirmed — check the table"', async () => {
    mockAmend.mockRejectedValue(new RequestOutcomeUnknownError('timeout'));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Cancellation NOT confirmed — check the table',
    );
    expect(m.onRefetch).toHaveBeenCalledTimes(1);
  });

  it('Modena, SERVER 502: "Cancellation NOT confirmed — check the table"', async () => {
    mockAmend.mockRejectedValue(new ApiRequestError('Bad gateway', 502));
    const m = await mount(MODENA);
    await removeWithApproval(m);
    expect(has(m.tree, 'amend-verdict-success')).toBe(false);
    expect(byId(m.tree, 'amend-verdict-title').props.children).toBe(
      'Cancellation NOT confirmed — check the table',
    );
  });
});
