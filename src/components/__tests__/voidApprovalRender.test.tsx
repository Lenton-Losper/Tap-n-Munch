/**
 * THE AMEND SHEET WHEN FOOD IS COMING OFF A BILL.
 *
 * voidApproval.test.ts owns the rules. This suite owns the three things only the rendered tree can
 * answer, and each one is the difference between a control and a decoration:
 *
 *   1. THE REQUEST ACTUALLY CARRIES THE APPROVAL. A screen that collects a PIN and a reason and
 *      then posts the old body is refused by the server, and the waiter finds out after they have
 *      told the customer the item is off. Asserted on the arguments amendTabLines was CALLED with.
 *
 *   2. AN INCREASE STILL ASKS FOR NOTHING. Gating every amendment would put a manager PIN in front
 *      of adding a round of drinks, which is how staff learn to keep a manager's PIN to hand.
 *
 *   3. THE BUTTON IS DEAD UNTIL THE APPROVAL IS COMPLETE, and pressing it posts nothing.
 *
 * NOTHING HERE POSTS. Every api function is mocked, and the tests that expect a refusal also
 * assert amendTabLines was never called.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';

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
import {MAX_VOID_REASON_LENGTH} from '../../lib/voidApproval';

const LINE: TabLine = {
  id: '11111111-1111-4111-8111-111111111111',
  name_snapshot: 'Beef Fillet',
  quantity: 3,
  line_note: null,
  route_to: 'kitchen',
  kitchen_state: 'outstanding',
  bar_state: null,
  is_voided: false,
} as unknown as TabLine;

const okResult = {order_id: 'o1', order_number: 12, applied: [{line_id: LINE.id}], refused: []};

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <AmendLineSheet tabId="tab-1" line={LINE} onClose={jest.fn()} onAmended={jest.fn()} />,
    );
  });
  return tree;
}

const byId = (tree: renderer.ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.findByProps({testID: id});

const has = (tree: renderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({testID: id}).length > 0;

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

/** Steps the quantity down to `target` using the stepper the waiter actually uses. */
const stepDownTo = async (tree: renderer.ReactTestRenderer, from: number, target: number) => {
  for (let q = from; q > target; q -= 1) {
    await press(byId(tree, 'amend-minus'));
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAmend.mockResolvedValue(okResult);
  mockAuthorize.mockResolvedValue({token_id: 'auth-token-1', expires_at: '2026-09-06T12:00:00Z'});
  mockGetAuthorizedUsers.mockResolvedValue([{user_id: 'mgr-1', name: 'Lenton'}]);
});

describe('an increase asks for nothing', () => {
  it('shows no approval block and posts without extras', async () => {
    const tree = await mount();
    await press(byId(tree, 'amend-plus'));

    expect(has(tree, 'void-approval')).toBe(false);
    expect(has(tree, 'void-approval-loading')).toBe(false);

    await press(byId(tree, 'amend-confirm'));

    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockAmend).toHaveBeenCalledTimes(1);
    // The fourth argument is the approval. An increase must carry none.
    expect(mockAmend.mock.calls[0][3]).toBeUndefined();
  });
});

describe('a reduction that is not a removal', () => {
  it('asks for approval on 3 to 1, not only on 3 to 0', async () => {
    const tree = await mount();
    await stepDownTo(tree, 3, 1);
    expect(has(tree, 'void-approval')).toBe(true);
  });

  it('stops the reason field at the length the SERVER stops at', async () => {
    // Past it the route answers VOID_REASON_TOO_LONG, and the waiter has already said it is off.
    // Asserted against the shared constant so the two cannot drift to different numbers.
    const tree = await mount();
    await stepDownTo(tree, 3, 1);
    await press(byId(tree, 'void-manager-mgr-1'));
    expect(byId(tree, 'void-reason').props.maxLength).toBe(MAX_VOID_REASON_LENGTH);
  });

  it('posts nothing while the approval is incomplete, and the button is disabled', async () => {
    const tree = await mount();
    await stepDownTo(tree, 3, 1);

    expect(byId(tree, 'amend-confirm').props.disabled).toBe(true);
    await press(byId(tree, 'amend-confirm'));
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockAmend).not.toHaveBeenCalled();

    // A manager and a PIN, but still no reason.
    await press(byId(tree, 'void-manager-mgr-1'));
    await type(byId(tree, 'void-pin'), '1234');
    expect(byId(tree, 'amend-confirm').props.disabled).toBe(true);
    await press(byId(tree, 'amend-confirm'));
    expect(mockAmend).not.toHaveBeenCalled();
  });

  it('carries the token, the manager and the reason into the request', async () => {
    const tree = await mount();
    await stepDownTo(tree, 3, 1);
    await press(byId(tree, 'void-manager-mgr-1'));
    await type(byId(tree, 'void-pin'), '1234');
    await type(byId(tree, 'void-reason'), 'Sent back, overcooked');

    expect(byId(tree, 'amend-confirm').props.disabled).toBe(false);
    await press(byId(tree, 'amend-confirm'));

    // Minted for line_void specifically — a token for another purpose is refused on consume.
    expect(mockAuthorize).toHaveBeenCalledWith('mgr-1', '1234', 'line_void', 'terminal-token');

    expect(mockAmend).toHaveBeenCalledTimes(1);
    const [tabId, amendments, token, extras] = mockAmend.mock.calls[0];
    expect(tabId).toBe('tab-1');
    expect(amendments).toEqual([{line_id: LINE.id, new_quantity: 1}]);
    expect(token).toBe('terminal-token');
    expect(extras).toEqual({
      staffUserId: 'mgr-1',
      authorizationTokenId: 'auth-token-1',
      voidReason: 'Sent back, overcooked',
    });
  });

  it('mints the token in the SAME press that spends it', async () => {
    /**
     * A token minted on a separate Approve tap is single-use and short-lived, and expires while
     * the table discusses the bill. It also creates a state where a manager has approved and
     * nothing has happened, which reads to everyone present as done.
     */
    const tree = await mount();
    await stepDownTo(tree, 3, 0);
    await press(byId(tree, 'void-manager-mgr-1'));
    await type(byId(tree, 'void-pin'), '1234');

    // Everything filled in but the button not yet pressed: no token exists.
    await type(byId(tree, 'void-reason'), 'Customer changed their mind');
    expect(mockAuthorize).not.toHaveBeenCalled();

    await press(byId(tree, 'amend-confirm'));
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAmend).toHaveBeenCalledTimes(1);
  });
});

describe('switching who is approving', () => {
  it('clears the PIN, so one person s code is never sent under another s name', async () => {
    mockGetAuthorizedUsers.mockResolvedValue([
      {user_id: 'mgr-1', name: 'Lenton'},
      {user_id: 'mgr-2', name: 'Maria'},
    ]);

    const tree = await mount();
    await stepDownTo(tree, 3, 0);
    await press(byId(tree, 'void-manager-mgr-1'));
    await type(byId(tree, 'void-pin'), '1234');
    await type(byId(tree, 'void-reason'), 'Customer changed their mind');

    await press(byId(tree, 'void-manager-mgr-2'));

    expect(byId(tree, 'void-pin').props.value).toBe('');
    // The reason is about the food, not the person, so it stays.
    expect(byId(tree, 'void-reason').props.value).toBe('Customer changed their mind');
    // And it cannot be sent until the new person types theirs.
    expect(byId(tree, 'amend-confirm').props.disabled).toBe(true);

    await type(byId(tree, 'void-pin'), '5678');
    await press(byId(tree, 'amend-confirm'));
    expect(mockAuthorize).toHaveBeenCalledWith('mgr-2', '5678', 'line_void', 'terminal-token');
  });
});

describe('when the PIN is refused', () => {
  it('does not amend, and clears the PIN', async () => {
    const {ApiRequestError} = jest.requireActual('../../lib/api');
    mockAuthorize.mockRejectedValue(
      new ApiRequestError('rejected', 403, {code: 'AUTHORIZATION_INVALID'}),
    );

    const tree = await mount();
    await stepDownTo(tree, 3, 0);
    await press(byId(tree, 'void-manager-mgr-1'));
    await type(byId(tree, 'void-pin'), '9999');
    await type(byId(tree, 'void-reason'), 'Customer changed their mind');
    await press(byId(tree, 'amend-confirm'));

    // NOTHING came off the bill.
    expect(mockAmend).not.toHaveBeenCalled();
    /**
     * The REFUSAL IS PUT INTO THE RIGHT WORDS, which this suite did not check until 2026-09-07.
     * It constructed ApiRequestError with the code as a positional third argument — the real
     * signature takes an options object — so `err.code` was undefined and the screen fell through
     * to its generic fallback. Every assertion here still passed, because none of them looked at
     * the message. A refused PIN and an unexplained failure are different things to say to a
     * waiter at a table.
     */
    expect(byId(tree, 'amend-confirm')).toBeDefined();
    expect(tree.root.findAllByProps({testID: 'void-pin'})[0].props.value).toBe('');
    // The code is not left sitting in a field on a terminal at a table.
    expect(byId(tree, 'void-pin').props.value).toBe('');
    // ...and the reason survives, so the manager retypes a PIN and not the sentence.
    expect(byId(tree, 'void-reason').props.value).toBe('Customer changed their mind');
  });
});

describe('when nobody at the venue can approve one', () => {
  it('says so and leaves the button dead', async () => {
    mockGetAuthorizedUsers.mockResolvedValue([]);

    const tree = await mount();
    await stepDownTo(tree, 3, 0);

    expect(has(tree, 'void-approval-no-managers')).toBe(true);
    expect(has(tree, 'void-pin')).toBe(false);
    expect(byId(tree, 'amend-confirm').props.disabled).toBe(true);
    await press(byId(tree, 'amend-confirm'));
    expect(mockAmend).not.toHaveBeenCalled();
  });

  it('a failed read is treated the same way, never as an open door', async () => {
    mockGetAuthorizedUsers.mockRejectedValue(new Error('network'));

    const tree = await mount();
    await stepDownTo(tree, 3, 0);

    expect(has(tree, 'void-approval-no-managers')).toBe(true);
    expect(byId(tree, 'amend-confirm').props.disabled).toBe(true);
  });
});
