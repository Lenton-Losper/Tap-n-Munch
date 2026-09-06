/**
 * THE CASH-UP SCREEN, AS A MANAGER USES IT.
 *
 * cashUp.test.ts owns the rules. This suite owns what only the rendered tree can answer:
 *
 *   1. THE PIN IS SPENT ON THE PERIOD THAT IS SELECTED. A screen that mints a token and then sends
 *      a different preset prints yesterday's takings under today's heading, and nothing on the
 *      paper would say so.
 *   2. THE BUTTON IS DEAD until somebody is named and a PIN is typed, and pressing it prints
 *      nothing.
 *   3. THE PIN NEVER SURVIVES A PRESS, successful or failed — it is somebody's code on a device
 *      that stays on the counter.
 *
 * NOTHING HERE PRINTS. Every api and printer function is mocked, and the tests that expect a
 * refusal also assert the printer was never reached.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

const mockAuthorize = jest.fn();
const mockGetAuthorizedUsers = jest.fn();
const mockPrintCashUp = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    authorizeTerminalAction: (...a: unknown[]) => mockAuthorize(...a),
    getAuthorizedUsers: (...a: unknown[]) => mockGetAuthorizedUsers(...a),
  };
});

jest.mock('../../lib/cashUpPrinting', () => ({
  printCashUp: (...a: unknown[]) => mockPrintCashUp(...a),
}));

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

import CashUpScreen from '../CashUpScreen';
import * as Copy from '../../constants/cashUpCopy';

const byId = (tree: renderer.ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.findByProps({testID: id});
const has = (tree: renderer.ReactTestRenderer, id: string) =>
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

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<CashUpScreen />);
  });
  return tree;
}

const okReport = (totalOrders = 20) => ({
  success: true,
  report: {
    period: {preset: 'today', label: 'Today', startDate: '2026-09-07', endDate: '2026-09-07', timezone: 'Africa/Windhoek'},
    summary: {
      paymentMethodSplit: [],
      totalRevenue: 1900,
      totalOrders,
      refundedTotal: 0,
      itemsSold: [],
      gratuityTotal: null,
      gratuityCount: null,
    },
    escposBase64: 'AA==',
    sdk6Lines: [],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthorizedUsers.mockResolvedValue([{user_id: 'mgr-1', name: 'Lenton'}]);
  mockAuthorize.mockResolvedValue({token_id: 'auth-1', expires_at: '2026-09-07T19:00:00Z'});
  mockPrintCashUp.mockResolvedValue(okReport());
});

describe('the button is dead until it can work', () => {
  it('prints nothing with nobody named', async () => {
    const tree = await mount();
    expect(byId(tree, 'cash-up-print').props.disabled).toBe(true);
    await press(byId(tree, 'cash-up-print'));
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockPrintCashUp).not.toHaveBeenCalled();
  });

  it('prints nothing with a manager but no PIN', async () => {
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    expect(byId(tree, 'cash-up-print').props.disabled).toBe(true);
    await press(byId(tree, 'cash-up-print'));
    expect(mockPrintCashUp).not.toHaveBeenCalled();
  });
});

describe('the PIN is spent on the period that is selected', () => {
  it('defaults to today', async () => {
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));

    expect(mockPrintCashUp).toHaveBeenCalledTimes(1);
    expect(mockPrintCashUp.mock.calls[0][0]).toEqual({
      preset: 'today',
      staffUserId: 'mgr-1',
      authorizationTokenId: 'auth-1',
    });
  });

  it('sends the period the manager actually chose, not the default', async () => {
    // The failure this rules out prints yesterday's takings under today's heading.
    const tree = await mount();
    await press(byId(tree, 'cash-up-period-yesterday'));
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));

    expect(mockPrintCashUp.mock.calls[0][0].preset).toBe('yesterday');
  });

  it('mints the token in the SAME press that prints', async () => {
    // A token minted on a separate tap is single-use and short-lived, and expires while somebody
    // counts a drawer.
    const tree = await mount();
    await press(byId(tree, 'cash-up-period-thisWeek'));
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    expect(mockAuthorize).not.toHaveBeenCalled();

    await press(byId(tree, 'cash-up-print'));
    expect(mockAuthorize).toHaveBeenCalledWith('mgr-1', '1234', 'cash_up', 'terminal-token');
    expect(mockPrintCashUp.mock.calls[0][0].preset).toBe('thisWeek');
  });

  it('offers exactly the three periods the server accepts', async () => {
    const tree = await mount();
    for (const id of ['today', 'yesterday', 'thisWeek']) {
      expect({id, present: has(tree, `cash-up-period-${id}`)}).toEqual({id, present: true});
    }
    for (const id of ['thisMonth', 'thisYear', 'last2days']) {
      expect({id, present: has(tree, `cash-up-period-${id}`)}).toEqual({id, present: false});
    }
  });
});

describe('the PIN never survives a press', () => {
  it('is cleared after a successful print', async () => {
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));
    expect(byId(tree, 'cash-up-pin').props.value).toBe('');
  });

  it('is cleared after a refused one, and nothing printed', async () => {
    const {ApiRequestError} = jest.requireActual('../../lib/api');
    mockAuthorize.mockRejectedValue(new ApiRequestError('no', 403, {code: 'AUTHORIZATION_INVALID'}));

    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '9999');
    await press(byId(tree, 'cash-up-print'));

    expect(mockPrintCashUp).not.toHaveBeenCalled();
    expect(byId(tree, 'cash-up-pin').props.value).toBe('');
    expect(byId(tree, 'cash-up-failure').props.children).toBe(Copy.CASH_UP_REFUSED_PIN);
  });

  it('is cleared when the manager is switched', async () => {
    mockGetAuthorizedUsers.mockResolvedValue([
      {user_id: 'mgr-1', name: 'Lenton'},
      {user_id: 'mgr-2', name: 'Maria'},
    ]);
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-manager-mgr-2'));

    expect(byId(tree, 'cash-up-pin').props.value).toBe('');
    expect(byId(tree, 'cash-up-print').props.disabled).toBe(true);
  });
});

describe('what the manager is told afterwards', () => {
  it('says it printed', async () => {
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));
    expect(byId(tree, 'cash-up-done').props.children).toBe(Copy.CASH_UP_PRINTED);
  });

  it('says so when the period was empty, rather than leaving a blank slip to explain itself', async () => {
    mockPrintCashUp.mockResolvedValue(okReport(0));
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));
    expect(byId(tree, 'cash-up-done').props.children).toBe(Copy.CASH_UP_NOTHING_TAKEN);
  });

  it('distinguishes a printer failure from a report failure', async () => {
    // The report was built and the PIN was spent; re-pressing needs a new PIN, and saying "could
    // not work it out" would send the manager looking in the wrong place.
    mockPrintCashUp.mockResolvedValue({success: false, errorCode: 'PRINT_FAILED'});
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));
    expect(byId(tree, 'cash-up-failure').props.children).toBe(Copy.CASH_UP_PRINTER_FAILED);
  });

  it('names the missing printer rather than blaming the report', async () => {
    mockPrintCashUp.mockResolvedValue({success: false, errorCode: 'NO_PRINTER_CONFIGURED'});
    const tree = await mount();
    await press(byId(tree, 'cash-up-manager-mgr-1'));
    await type(byId(tree, 'cash-up-pin'), '1234');
    await press(byId(tree, 'cash-up-print'));
    expect(byId(tree, 'cash-up-failure').props.children).toBe(Copy.CASH_UP_NO_PRINTER);
  });
});

describe('when nobody can authorise one', () => {
  it('says so and offers no PIN field', async () => {
    mockGetAuthorizedUsers.mockResolvedValue([]);
    const tree = await mount();
    expect(has(tree, 'cash-up-no-managers')).toBe(true);
    expect(has(tree, 'cash-up-pin')).toBe(false);
    expect(byId(tree, 'cash-up-print').props.disabled).toBe(true);
  });

  it('treats a failed read the same way, never as an open door', async () => {
    mockGetAuthorizedUsers.mockRejectedValue(new Error('network'));
    const tree = await mount();
    expect(has(tree, 'cash-up-no-managers')).toBe(true);
    expect(byId(tree, 'cash-up-print').props.disabled).toBe(true);
  });
});
