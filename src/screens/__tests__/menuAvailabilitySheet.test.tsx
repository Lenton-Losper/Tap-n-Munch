/**
 * THE TWO PROPERTIES THE ITEM DETAIL SHEET EXISTS FOR.
 *
 * 1. THE NAME IN THE SHEET COMES FROM THE FETCHED RECORD, NOT THE TAPPED TILE.
 *
 *    The whole design rests on it: "a waiter marking a dish unavailable mid-service is one tap
 *    away from a waiter marking the wrong dish unavailable mid-service." If the sheet echoed the
 *    tile that was tapped, a mis-tap would show the name the waiter already believes they picked
 *    and the confirmation would confirm nothing. So the screen re-reads the item and renders THAT
 *    name, large, above every button.
 *
 *    The tests below make the two names DISAGREE on purpose — the tile says one dish, the record
 *    says another — which is exactly the state a mis-tap produces and the only state in which the
 *    difference is observable.
 *
 * 2. NOTHING CHANGES BEFORE THE 200 RESOLVES.
 *
 *    The value of the call is the server-side menu-cache invalidation having COMPLETED. Showing
 *    the dish as hidden while the write is still in flight teaches waiters to trust a state that
 *    is not real, and the state it teaches them to trust is "nobody can order this" — the one that
 *    matters if it is wrong. The request is therefore held open mid-flight and the screen is
 *    inspected while it hangs.
 *
 * HOW EACH ONE WAS SEEN TO FAIL. Both breaks were applied to MenuItemDetailScreen.tsx, run, and
 * reverted; what is written here is what the runner actually printed, not what was expected.
 *
 *   - Property 1: render `route.params.tappedName` instead of `item.name` in the sheet's
 *     sheetItemName Text. The first test fails with
 *     `Expected substring: "Beef Fillet"` against a sheet that no longer contains it.
 *
 *     NOTE, because it matters for what the second test is worth: the second test still PASSED
 *     under that break. It inspects the screen before the sheet has ever been opened, and a closed
 *     Modal renders nothing — so it cannot see into the sheet at all. It is the narrower guard, on
 *     the "show the tapped name while the record loads" shortcut, and only the FIRST test covers
 *     the sheet itself. Deleting the first one would leave the property untested while the suite
 *     stayed green.
 *
 *   - Property 2: move the setItem/recordAvailabilityChange pair ABOVE the
 *     `await setMenuItemAvailability(...)` call. Two tests fail: the in-flight one on the status
 *     label having already flipped to hidden, and the refusal one on an override having been
 *     recorded for a change the server refused.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Modal, Text} from 'react-native';

import * as Copy from '../../constants/menuAvailabilityCopy';
import {
  availabilityOverride,
  clearAvailabilityOverrides,
} from '../../lib/menuAvailabilityOverrides';

/** The record the SERVER holds. Deliberately not what the tile said. */
const FETCHED_NAME = 'Beef Fillet';
/** What the waiter's finger actually landed on. Must never reach the screen. */
const TAPPED_NAME = 'Grilled Kingklip';

const menuItem = {
  id: 'item-77',
  name: FETCHED_NAME,
  description: null,
  base_price: 245,
  is_available: true,
  image_url: null,
  category_id: 'cat-1',
};

const mockGetMenuItems = jest.fn(async () => [menuItem]);
const mockGetAuthorizedUsers = jest.fn(async () => [
  {user_id: 'user-9', name: 'Selma'},
]);
const mockAuthorizeAction = jest.fn(async () => ({
  token_id: 'auth-token-1',
  expires_at: '2026-08-28T10:00:00.000Z',
}));

/** Resolvers for every availability call currently held open. */
let pendingWrites: Array<(value: unknown) => void> = [];
let holdWrites = false;
let nextWriteResult: unknown = {
  ok: true,
  item: {id: 'item-77', name: FETCHED_NAME, status: 'hidden'},
  hidden: true,
};

const mockSetMenuItemAvailability = jest.fn(() => {
  if (!holdWrites) {
    return Promise.resolve(nextWriteResult);
  }
  return new Promise(resolve => {
    pendingWrites.push(resolve);
  });
});

jest.mock('../../lib/api', () => ({
  getMenuItems: (...args: unknown[]) => mockGetMenuItems(...(args as [])),
  getAuthorizedUsers: (...args: unknown[]) =>
    mockGetAuthorizedUsers(...(args as [])),
  authorizeAction: (...args: unknown[]) => mockAuthorizeAction(...(args as [])),
  setMenuItemAvailability: (...args: unknown[]) =>
    mockSetMenuItemAvailability(...(args as [])),
  isPinLockedError: () => false,
  staffMessageForPinLock: () => 'locked',
  // The screen branches on `instanceof`, so these must be real constructors. Declared inside the
  // factory because jest.mock is hoisted above every out-of-scope binding.
  ApiRequestError: class extends Error {},
  AuthorizationDeniedError: class extends Error {},
}));

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'jwt'),
  getRestaurantId: jest.fn(async () => 'restaurant-1'),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');
// Imported for its TYPES only; stubbed so the suite never drags the navigator tree in.
jest.mock('../../navigation/AppNavigator', () => ({}));

import MenuItemDetailScreen from '../MenuItemDetailScreen';

const screenProps = {
  route: {
    params: {itemId: 'item-77', categoryId: 'cat-1', tappedName: TAPPED_NAME},
  },
  navigation: {goBack: jest.fn(), navigate: jest.fn()},
} as unknown as React.ComponentProps<typeof MenuItemDetailScreen>;

/** Text of a React element subtree, used to locate a control by its label. */
function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(elementText).join('');
  }
  const props = (node as {props?: {children?: unknown}}).props;
  return props ? elementText(props.children) : '';
}

/** Every string the screen renders — the artefact a member of staff actually looks at. */
function renderedText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as {children?: unknown[]} | null)?.children;
    if (children) {
      children.forEach(walk);
    }
  };
  walk(json);
  return out.join('\n');
}

async function flush() {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Mounting a screen pays for transforming react-native's whole module graph — a fixed setup cost
 * measured in tens of seconds on a cold cache, far above jest's 5s default. Same reasoning as
 * orderDetailReprint.test.tsx.
 */
jest.setTimeout(120000);

describe('menu availability sheet', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    clearAvailabilityOverrides();
    mockSetMenuItemAvailability.mockClear();
    mockAuthorizeAction.mockClear();
    pendingWrites = [];
    holdWrites = false;
    nextWriteResult = {
      ok: true,
      item: {id: 'item-77', name: FETCHED_NAME, status: 'hidden'},
      hidden: true,
    };
  });

  afterEach(async () => {
    // Nothing may stay in flight across tests: an abandoned write would land its state updates
    // during the NEXT test, after its mockClear().
    await renderer.act(async () => {
      pendingWrites.splice(0).forEach(resolve =>
        resolve({
          ok: false,
          refusal: 'already_in_that_state',
          message: 'unwound by teardown',
        }),
      );
    });
    await flush();
    await renderer.act(async () => {
      trees.forEach(tree => tree.unmount());
    });
    trees = [];
  });

  async function mountScreen(): Promise<renderer.ReactTestRenderer> {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<MenuItemDetailScreen {...screenProps} />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  function pressableWithText(tree: renderer.ReactTestRenderer, text: string) {
    return tree.root.find(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(text),
    );
  }

  /**
   * The sheet is the Modal's subtree. Scoped deliberately: the control button behind the sheet
   * carries the SAME signed label as the accept button inside it ("Mark unavailable"), so a
   * whole-tree search would find the wrong one.
   */
  function sheet(tree: renderer.ReactTestRenderer) {
    return tree.root.findByType(Modal);
  }

  /** Every string rendered inside one subtree. A ReactTestInstance has no toJSON. */
  function subtreeText(instance: renderer.ReactTestInstance): string {
    return instance
      .findAllByType(Text)
      .map(node => elementText(node.props.children))
      .join('\n');
  }

  async function openSheet(tree: renderer.ReactTestRenderer) {
    const control = pressableWithText(tree, Copy.CONTROL_BUTTON_HIDE);
    await renderer.act(async () => {
      control.props.onPress();
    });
    await flush();
  }

  async function enterPinAndAccept(tree: renderer.ReactTestRenderer) {
    const input = sheet(tree).findByProps({placeholder: '••••'});
    await renderer.act(async () => {
      input.props.onChangeText('1234');
    });
    const accept = sheet(tree).find(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(Copy.SHEET_ACCEPT_LABEL),
    );
    await renderer.act(async () => {
      accept.props.onPress();
    });
    await flush();
  }

  // ── Property 1: the name is the fetched one ────────────────────────────────────────────────

  it('shows the FETCHED dish name in the sheet, not the name of the tile that was tapped', async () => {
    const tree = await mountScreen();
    await openSheet(tree);

    const onSheet = subtreeText(sheet(tree));

    expect(onSheet).toContain(FETCHED_NAME);
    // The mis-tap case: the tile said Kingklip, the record says Fillet, and the waiter must read
    // the record. If this ever fails, the confirmation has stopped confirming anything.
    expect(onSheet).not.toContain(TAPPED_NAME);
  });

  it('never renders the tapped name anywhere on the screen, loading included', async () => {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<MenuItemDetailScreen {...screenProps} />);
    });
    trees.push(tree);

    // Before the record has arrived — the moment a "show it while it loads" shortcut would show.
    expect(renderedText(tree.toJSON())).not.toContain(TAPPED_NAME);

    await flush();
    expect(renderedText(tree.toJSON())).not.toContain(TAPPED_NAME);
  });

  // ── Property 2: no optimistic UI ───────────────────────────────────────────────────────────

  it('does not change the item state until the response resolves', async () => {
    const tree = await mountScreen();
    expect(renderedText(tree.toJSON())).toContain(Copy.STATUS_AVAILABLE);

    holdWrites = true;
    await openSheet(tree);
    await enterPinAndAccept(tree);

    // The request is in flight and has NOT come back.
    expect(mockSetMenuItemAvailability).toHaveBeenCalledTimes(1);
    expect(pendingWrites).toHaveLength(1);

    const midFlight = renderedText(tree.toJSON());
    expect(midFlight).toContain(Copy.STATUS_AVAILABLE);
    expect(midFlight).not.toContain(Copy.STATUS_HIDDEN);
    // And nothing has been written for the menu grid to pick up either.
    expect(availabilityOverride('item-77')).toBeNull();

    await renderer.act(async () => {
      pendingWrites.splice(0).forEach(resolve =>
        resolve({
          ok: true,
          item: {id: 'item-77', name: FETCHED_NAME, status: 'hidden'},
          hidden: true,
        }),
      );
    });
    await flush();

    // Only now.
    const settled = renderedText(tree.toJSON());
    expect(settled).toContain(Copy.STATUS_HIDDEN);
    expect(settled).not.toContain(Copy.STATUS_AVAILABLE);
    expect(availabilityOverride('item-77')).toBe(false);
  });

  it('shows the undo action in the success toast after a hide', async () => {
    const tree = await mountScreen();
    await openSheet(tree);
    await enterPinAndAccept(tree);

    const after = renderedText(tree.toJSON());
    expect(after).toContain(Copy.SUCCESS_HIDDEN);
    // The real safety net: a restore action, on the toast, for UNDO_WINDOW_MS.
    expect(after).toContain(Copy.RESTORE_BUTTON);
  });

  // ── Refusals are rendered, not retried ─────────────────────────────────────────────────────

  it('renders the server message for a refusal and does not re-issue the request', async () => {
    nextWriteResult = {
      ok: false,
      refusal: 'authorization_failed',
      message: 'That PIN did not work. Try again, or ask a manager to do it.',
    };

    const tree = await mountScreen();
    await openSheet(tree);
    await enterPinAndAccept(tree);

    expect(renderedText(tree.toJSON())).toContain(
      'That PIN did not work. Try again, or ask a manager to do it.',
    );
    // ONE attempt. A refusal is an answer; retrying it is the loop this feature must not have.
    expect(mockSetMenuItemAvailability).toHaveBeenCalledTimes(1);
    // And the dish is still shown as it was — a refused change changed nothing.
    expect(availabilityOverride('item-77')).toBeNull();
  });
});
