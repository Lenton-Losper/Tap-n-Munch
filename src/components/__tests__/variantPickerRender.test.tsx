/**
 * THE VARIANT PICKER, RENDERED -- POS sale picker, Add-a-Round item sheet, and the round review.
 * Sprint 2026-09-28 brief: "display available variants, allow selecting, send the selected variant
 * identity, display selected variant, display correct variant price".
 *
 * Each "blocked" assertion has a positive control beside it (the same control ENABLED once the
 * group is answered), so a sheet that failed to render could not pass by being empty.
 */
import React from 'react';
import renderer, {act, type ReactTestInstance} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

const mockSendRound = jest.fn();
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {...actual, sendRound: (...a: unknown[]) => mockSendRound(...a)};
});
jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {...actual, getTerminalToken: jest.fn(async () => 'terminal-token')};
});

let mockSession: Record<string, unknown> = {};
jest.mock('../../context/ServiceSessionContext', () => ({
  useServiceSession: () => mockSession,
}));

import VariantPicker from '../VariantPicker';
import RoundItemSheet from '../RoundItemSheet';
import ServiceRoundReviewScreen from '../../screens/ServiceRoundReviewScreen';
import {addLine} from '../../lib/serviceRound';
import type {VariantPricedItem} from '../../lib/variantPricing';

const AMERICANO: VariantPricedItem = {
  id: 'm-americano',
  name: 'Americano',
  base_price: 0,
  variant_groups: [
    {
      name: 'Size',
      required: true,
      type: 'price',
      options: [
        {label: 'Small', price: 25},
        {label: 'Large', price: 45},
      ],
    },
    {name: 'Milk', required: false, type: 'text', options: [{label: 'Oat', price: null}]},
  ],
};

const first = (tree: renderer.ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.findAllByProps({testID: id})[0];

const texts = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).map(t =>
    ([] as unknown[])
      .concat(t.props.children)
      .filter(c => typeof c === 'string' || typeof c === 'number')
      .join(''),
  );

const press = async (node: ReactTestInstance) => {
  await act(async () => {
    node.props.onPress();
  });
};

describe('POS VariantPicker', () => {
  it('Add is disabled until the required size is chosen, then sends the selection', async () => {
    const onConfirm = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <VariantPicker item={AMERICANO} onCancel={jest.fn()} onConfirm={onConfirm} />,
      );
    });

    expect(first(tree, 'variant-picker-add').props.disabled).toBe(true);
    // Pressing it anyway does nothing: the handler has its own guard.
    await press(first(tree, 'variant-picker-add'));
    expect(onConfirm).not.toHaveBeenCalled();
    // Zero base, nothing chosen: says what to choose, never N$0.00.
    expect(texts(tree).join('|')).not.toContain('N$0.00');
    expect(first(tree, 'variant-price-pending')).toBeDefined();

    // Options are shown with their prices.
    expect(texts(tree)).toEqual(expect.arrayContaining(['Small', 'N$25.00', 'Large', 'N$45.00']));

    await press(first(tree, 'variant-option-Size-Large'));
    expect(first(tree, 'variant-picker-add').props.disabled).toBe(false);
    expect(texts(tree)).toContain('N$45.00');
    expect(first(tree, 'variant-price')).toBeDefined();

    await press(first(tree, 'variant-picker-add'));
    expect(onConfirm).toHaveBeenCalledWith({Size: 'Large'});
  });
});

describe('Add-a-Round item sheet', () => {
  it('offers the groups, blocks confirm until answered, prices the variant, sends the selection', async () => {
    const onConfirm = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RoundItemSheet item={AMERICANO} onCancel={jest.fn()} onConfirm={onConfirm} />,
      );
    });

    expect(first(tree, 'variant-group-Size')).toBeDefined();
    expect(first(tree, 'item-sheet-confirm').props.disabled).toBe(true);
    await press(first(tree, 'item-sheet-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(texts(tree).join('|')).not.toContain('N$0.00');

    await press(first(tree, 'variant-option-Size-Small'));
    await press(first(tree, 'item-sheet-plus'));
    expect(first(tree, 'item-sheet-confirm').props.disabled).toBe(false);
    // 2 x Small at 25.
    expect(texts(tree)).toContain('N$50.00');

    await press(first(tree, 'item-sheet-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({quantity: 2, selectedVariants: {Size: 'Small'}}),
    );
  });

  it('an item with no groups keeps the plain sheet', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RoundItemSheet
          item={{id: 'm-coke', name: 'Coke', base_price: 25}}
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByProps({testID: 'variant-group-Size'})).toHaveLength(0);
    expect(first(tree, 'item-sheet-confirm').props.disabled).toBe(false);
    expect(texts(tree)).toContain('N$25.00');
  });

  it('reopening a variant line shows its variant, read-only', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RoundItemSheet
          item={{
            ...AMERICANO,
            base_price: 45,
            editing: {lineId: 'l1', quantity: 1, note: '', selectedVariants: {Size: 'Large'}},
          }}
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      );
    });
    expect(texts(tree)).toContain('Americano - Large');
    expect(tree.root.findAllByProps({testID: 'variant-group-Size'})).toHaveLength(0);
    expect(texts(tree)).toContain('N$45.00');
  });
});

describe('the round with a variant', () => {
  it('review shows "Americano - Large" at the variant price and sends selectedVariants', async () => {
    const lines = addLine([], AMERICANO, {selectedVariants: {Size: 'Large'}});
    mockSession = {
      table: {tabId: 'tab-1', tableId: 't-1', tableName: 'T4'},
      lines,
      idempotencyKey: 'round_abc',
      orderInstructions: '',
      setOrderInstructions: jest.fn(),
      clearBasket: jest.fn(),
      endSession: jest.fn(),
    };
    mockSendRound.mockResolvedValue({
      order_id: 'o1',
      order_number: 9,
      lines_written: true,
      line_count: 1,
      station_counts: {kitchen: 0, bar: 1, unrouted: 0},
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ServiceRoundReviewScreen
          {...({navigation: {navigate: jest.fn(), popToTop: jest.fn(), goBack: jest.fn()}, route: {params: {}}} as unknown as React.ComponentProps<typeof ServiceRoundReviewScreen>)}
        />,
      );
    });

    expect(texts(tree)).toContain('Americano - Large');
    expect(texts(tree)).toContain('N$45.00');

    const send = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => texts({root: n} as unknown as renderer.ReactTestRenderer).some(t => /^Send/i.test(t)));
    expect(send).toBeDefined();
    await press(send!);

    expect(mockSendRound).toHaveBeenCalledTimes(1);
    expect(mockSendRound.mock.calls[0][0].items).toEqual([
      {menuItemId: 'm-americano', name: 'Americano', quantity: 1, selectedVariants: {Size: 'Large'}},
    ]);
  });
});
