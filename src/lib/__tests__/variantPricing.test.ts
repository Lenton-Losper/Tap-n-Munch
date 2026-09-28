/**
 * VARIANTS ON THE TERMINAL -- the pure rules. Sprint 2026-09-28 brief.
 *
 * The server reprices every line, so what is pinned here is the two things that still cost money
 * when they drift on the device:
 *
 *   1. The price SHOWN must be the price the server CHARGES. The server's rule (web
 *      lib/menu/variant-groups.ts findSelectedVariantPrice + calculate-order-pricing.ts
 *      priceCatalogLine) is: the first priced group whose option was chosen REPLACES base_price;
 *      text groups never price; nothing is summed across groups.
 *   2. Line identity: a Large and a Small are two lines, on the POS cart and in a round.
 *
 * MUTATIONS these suites were run against (see the report for the RED output):
 *   M1 buildRoundItems without selectedVariants        -> "buildRoundItems sends selectedVariants"
 *   M2 merge key without the selection                 -> "two sizes are two lines" (cart + round)
 *   M3 add allowed with a required group missing       -> "a required group left open blocks the add"
 */
import {
  canonicalSelection,
  displayUnitPrice,
  formatPriceRange,
  isSelectionComplete,
  mapResolvedVariantGroups,
  priceRange,
  variantDisplayName,
  variantLineKey,
  variantSummary,
  variantUnitPrice,
  type VariantPricedItem,
} from '../variantPricing';
import {addLine, buildRoundItems, outOfStockLineIds, roundLineLabel} from '../serviceRound';
import {addCartLine, buildPOSOrderItems} from '../../context/CartContext';

const americano: VariantPricedItem = {
  id: 'm-americano',
  name: 'Americano',
  base_price: 30,
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
    {
      name: 'Milk',
      required: false,
      type: 'text',
      options: [
        {label: 'Oat', price: null},
        {label: 'Full cream', price: null},
      ],
    },
  ],
};

/** Base 0 -- the venue priced only the sizes. Displaying the base would read N$0.00. */
const zeroBase: VariantPricedItem = {
  id: 'm-cappuccino',
  name: 'Cappuccino',
  base_price: 0,
  variant_groups: [
    {
      name: 'Size',
      required: true,
      type: 'price',
      options: [
        {label: 'Regular', price: 35},
        {label: 'Large', price: 45},
      ],
    },
  ],
};

const plain: VariantPricedItem = {id: 'm-coke', name: 'Coke', base_price: 25};

describe('pricing mirrors the server', () => {
  it('a priced option REPLACES the base price', () => {
    expect(variantUnitPrice(americano, {Size: 'Large'})).toBe(45);
    expect(variantUnitPrice(americano, {Size: 'Small'})).toBe(25);
  });

  it('a text group adds nothing, and nothing is summed across groups', () => {
    // The server has no additive variant group: first priced match wins, text never prices.
    expect(variantUnitPrice(americano, {Size: 'Large', Milk: 'Oat'})).toBe(45);

    const twoPriced: VariantPricedItem = {
      id: 'm-2',
      name: 'Combo',
      base_price: 10,
      variant_groups: [
        {name: 'Size', required: true, type: 'price', options: [{label: 'L', price: 40}]},
        {name: 'Extra', required: false, type: 'price', options: [{label: 'Shot', price: 12}]},
      ],
    };
    // First priced group wins; the second does NOT add 12 on top. Showing 52 would display a
    // figure the server never charges.
    expect(variantUnitPrice(twoPriced, {Size: 'L', Extra: 'Shot'})).toBe(40);
    // With the first group unanswered, the second one is the first match.
    expect(variantUnitPrice(twoPriced, {Extra: 'Shot'})).toBe(12);
  });

  it('no selection falls back to base, exactly like the server', () => {
    expect(variantUnitPrice(americano, {})).toBe(30);
    expect(variantUnitPrice(plain, {})).toBe(25);
  });

  it('a zero-base item with a valid variant never shows N$0', () => {
    expect(displayUnitPrice(zeroBase, {Size: 'Regular'})).toBe(35);
    // Unanswered: no price at all rather than the server's base fallback of 0.
    expect(displayUnitPrice(zeroBase, {})).toBeNull();
    // The tile range excludes the unreachable base.
    expect(priceRange(zeroBase)).toEqual({min: 35, max: 45});
    expect(formatPriceRange(zeroBase)).toBe('N$35.00 – N$45.00');
    expect(formatPriceRange(zeroBase)).not.toContain('N$0.00');
  });

  it('an unknown option does not count as an answer or a price', () => {
    expect(canonicalSelection(americano, {Size: 'Venti', Colour: 'Red'})).toEqual({});
    expect(isSelectionComplete(americano, {Size: 'Venti'})).toBe(false);
    expect(variantUnitPrice(americano, {Size: 'Venti'})).toBe(30);
  });
});

describe('a required group left open blocks the add', () => {
  it('isSelectionComplete is false until every required group is answered', () => {
    expect(isSelectionComplete(americano, {})).toBe(false);
    expect(isSelectionComplete(americano, {Milk: 'Oat'})).toBe(false);
    expect(isSelectionComplete(americano, {Size: 'Large'})).toBe(true);
    expect(isSelectionComplete(plain, {})).toBe(true);
  });

  it('the round basket refuses the line', () => {
    expect(addLine([], americano, {selectedVariants: {}})).toEqual([]);
    expect(addLine([], americano)).toEqual([]);
    expect(addLine([], americano, {selectedVariants: {Size: 'Large'}})).toHaveLength(1);
  });

  it('the POS cart refuses the line', () => {
    expect(addCartLine([], americano)).toEqual([]);
    expect(addCartLine([], americano, {Size: 'Large'})).toHaveLength(1);
  });

  it('an item whose groups are UNKNOWN (older server) still adds -- the server is the authority', () => {
    const unknown: VariantPricedItem = {...plain, variant_groups: null};
    expect(addLine([], unknown)).toHaveLength(1);
    expect(addCartLine([], unknown)).toHaveLength(1);
  });
});

describe('two sizes are two lines', () => {
  it('the key includes the selection, independent of key order', () => {
    expect(variantLineKey('m', {Size: 'Large'})).not.toBe(variantLineKey('m', {Size: 'Small'}));
    expect(variantLineKey('m', {a: '1', b: '2'})).toBe(variantLineKey('m', {b: '2', a: '1'}));
    // No selection keys on the id alone -- how every line was keyed before variants.
    expect(variantLineKey('m', {})).toBe('m');
  });

  it('round basket: Large and Small do not merge; Large twice does', () => {
    let lines = addLine([], americano, {selectedVariants: {Size: 'Large'}});
    lines = addLine(lines, americano, {selectedVariants: {Size: 'Small'}});
    lines = addLine(lines, americano, {selectedVariants: {Size: 'Large'}});
    expect(lines).toHaveLength(2);
    expect(lines.map(l => [roundLineLabel(l), l.unitPrice, l.quantity])).toEqual([
      ['Americano - Large', 45, 2],
      ['Americano - Small', 25, 1],
    ]);
  });

  it('POS cart: Large and Small do not merge; Large twice does', () => {
    let cart = addCartLine([], americano, {Size: 'Large'});
    cart = addCartLine(cart, americano, {Size: 'Small'});
    cart = addCartLine(cart, americano, {Size: 'Large'});
    expect(cart).toHaveLength(2);
    expect(cart.map(l => [l.displayName, l.basePrice, l.quantity, l.subtotal])).toEqual([
      ['Americano - Large', 45, 2, 90],
      ['Americano - Small', 25, 1, 25],
    ]);
  });
});

describe('what leaves the device (C6)', () => {
  it('buildRoundItems sends selectedVariants, and the menu name rather than the display name', () => {
    const lines = addLine(addLine([], americano, {selectedVariants: {Size: 'Large', Milk: 'Oat'}}), plain);
    expect(buildRoundItems(lines)).toEqual([
      {
        menuItemId: 'm-americano',
        name: 'Americano',
        quantity: 1,
        selectedVariants: {Size: 'Large', Milk: 'Oat'},
      },
      // A plain item's payload is exactly what it was before variants.
      {menuItemId: 'm-coke', name: 'Coke', quantity: 1},
    ]);
  });

  it('the POS payload sends selectedVariants and strips device-only fields', () => {
    const cart = addCartLine(addCartLine([], americano, {Size: 'Small'}), plain);
    expect(buildPOSOrderItems(cart)).toEqual([
      {
        menuItemId: 'm-americano',
        name: 'Americano',
        quantity: 1,
        basePrice: 25,
        subtotal: 25,
        selectedVariants: {Size: 'Small'},
      },
      {menuItemId: 'm-coke', name: 'Coke', quantity: 1, basePrice: 25, subtotal: 25},
    ]);
  });

  it('an out-of-stock refusal naming the variant display name still flags the line', () => {
    const lines = addLine([], americano, {selectedVariants: {Size: 'Large'}});
    expect(outOfStockLineIds(lines, [{item: 'Americano - Large'}])).toEqual([lines[0].lineId]);
    expect(outOfStockLineIds(lines, [{item: 'Americano'}])).toEqual([lines[0].lineId]);
  });
});

describe('C6 resolved_variant_groups mapping', () => {
  it('maps groups, options and prices', () => {
    expect(
      mapResolvedVariantGroups([
        {name: 'Size', required: true, type: 'price', options: [{label: 'Large', price: 45}]},
        {name: 'Milk', required: false, type: 'text', options: [{label: 'Oat', price: 0}, 'Soy']},
      ]),
    ).toEqual([
      {name: 'Size', required: true, type: 'price', options: [{label: 'Large', price: 45}]},
      {
        name: 'Milk',
        required: false,
        type: 'text',
        options: [
          {label: 'Oat', price: null},
          {label: 'Soy', price: null},
        ],
      },
    ]);
  });

  it('tolerates absence: null means "not said", [] means "none"', () => {
    expect(mapResolvedVariantGroups(undefined)).toBeNull();
    expect(mapResolvedVariantGroups('nope')).toBeNull();
    expect(mapResolvedVariantGroups([])).toEqual([]);
  });

  it('drops what the server would not price: no name, no type, unpriced price options', () => {
    expect(
      mapResolvedVariantGroups([
        {name: '', type: 'price', options: [{label: 'A', price: 1}]},
        {name: 'X', type: 'weird', options: [{label: 'A', price: 1}]},
        {name: 'Size', required: true, type: 'price', options: [{label: 'L', price: null}, {label: 'S', price: 20}]},
      ]),
    ).toEqual([{name: 'Size', required: true, type: 'price', options: [{label: 'S', price: 20}]}]);
  });
});

describe('display helpers', () => {
  it('builds the display name the server writes for stations and receipts', () => {
    expect(variantDisplayName('Americano', {Size: 'Large', Milk: 'Oat'})).toBe(
      'Americano - Large / Oat',
    );
    expect(variantDisplayName('Americano', {})).toBe('Americano');
  });

  it('summarises a persisted selection for an existing order', () => {
    expect(variantSummary({Size: 'Large', Milk: ['Oat']})).toBe('Large / Oat');
    expect(variantSummary(null)).toBeUndefined();
    expect(variantSummary({})).toBeUndefined();
  });
});

describe('existing orders show their variant', () => {
  const {mapRowToOrder} = require('../orderMapper') as typeof import('../orderMapper');
  const row = (items: unknown[]) => ({id: 'o', restaurant_id: 'r', items, total: 0});

  it('reads the persisted selectedVariants', () => {
    const order = mapRowToOrder(
      row([{name: 'Americano', quantity: 1, price: 45, selectedVariants: {Size: 'Large'}}]),
    );
    expect(order.items[0].variant).toBe('Large');
  });

  it('does not repeat a variant the server already wrote into the name', () => {
    const order = mapRowToOrder(
      row([{name: 'Americano - Large', quantity: 1, price: 45, selectedVariants: {Size: 'Large'}}]),
    );
    expect(order.items[0].name).toBe('Americano - Large');
    expect(order.items[0].variant).toBeUndefined();
  });

  it('a line with no selection has no variant', () => {
    expect(mapRowToOrder(row([{name: 'Coke', quantity: 1, price: 25}])).items[0].variant).toBeUndefined();
  });
});
