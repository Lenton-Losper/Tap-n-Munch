/**
 * VARIANTS ON THE WIRE -- C5/C6 from the terminal's side. Sprint 2026-09-28 brief.
 *
 * Read what api.ts actually receives and sends, through the shared harness, rather than trusting
 * the pure helpers alone: a mapper that drops `resolved_variant_groups`, or a caller that passes
 * the cart straight through, would both leave every unit test green.
 */
import {withApi} from './helpers/apiHarness';
import {addLine, buildRoundItems} from '../serviceRound';
import {addCartLine, buildPOSOrderItems} from '../../context/CartContext';

jest.mock('../storage', () => ({
  getRefreshToken: jest.fn(async () => null),
  saveTerminalToken: jest.fn(async () => undefined),
  saveRefreshToken: jest.fn(async () => undefined),
  saveRestaurantId: jest.fn(async () => undefined),
  saveTerminalId: jest.fn(async () => undefined),
  saveRestaurantName: jest.fn(async () => undefined),
  saveMerchantCredentials: jest.fn(async () => undefined),
}));

const ROW = {
  id: 'm-americano',
  name: 'Americano',
  description: null,
  base_price: 0,
  status: 'available',
  image_url: null,
  category_id: 'cat-1',
  resolved_variant_groups: [
    {
      name: 'Size',
      required: true,
      type: 'price',
      options: [
        {label: 'Small', price: 25},
        {label: 'Large', price: 45},
      ],
    },
  ],
};

describe('GET /api/menu/{rid}/category/{cid} -> MenuItem', () => {
  it('maps resolved_variant_groups into variant_groups', async () => {
    const items = await withApi({status: 200, body: {items: [ROW]}}, api =>
      api.getMenuItems('jwt', 'r-1', 'cat-1'),
    );
    expect(items[0].variant_groups).toEqual([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          {label: 'Small', price: 25},
          {label: 'Large', price: 45},
        ],
      },
    ]);
  });

  it('an older server with no field gives null (unknown), not a crash and not []', async () => {
    const legacy: Record<string, unknown> = {...ROW};
    delete legacy.resolved_variant_groups;
    const items = await withApi({status: 200, body: {items: [legacy]}}, api =>
      api.getMenuItems('jwt', 'r-1', 'cat-1'),
    );
    expect(items[0].variant_groups).toBeNull();
    expect(items[0].name).toBe('Americano');
  });
});

describe('POST /api/terminal/orders carries selectedVariants', () => {
  it('each variant line sends its selection', async () => {
    const item = {id: ROW.id, name: ROW.name, base_price: 0, variant_groups: [
      {name: 'Size', required: true, type: 'price' as const, options: [
        {label: 'Small', price: 25}, {label: 'Large', price: 45}]},
    ]};
    let cart = addCartLine([], item, {Size: 'Large'});
    cart = addCartLine(cart, item, {Size: 'Small'});

    const body = await withApi(
      {status: 200, body: {orderId: 'o-1', orderNumber: 7}},
      async (api, calls) => {
        await api.createPOSOrder('jwt', {
          restaurantId: 'r-1',
          items: buildPOSOrderItems(cart),
          subtotal: 70,
          total: 70,
          idempotencyKey: 'pos_1',
        });
        return JSON.parse(String(calls[0].init.body));
      },
    );
    expect(body.items).toEqual([
      {menuItemId: 'm-americano', name: 'Americano', quantity: 1, basePrice: 45, subtotal: 45,
        selectedVariants: {Size: 'Large'}},
      {menuItemId: 'm-americano', name: 'Americano', quantity: 1, basePrice: 25, subtotal: 25,
        selectedVariants: {Size: 'Small'}},
    ]);
  });

  it('a C5 400 is surfaced with its code and NOT retried', async () => {
    const outcome = await withApi(
      {
        status: 400,
        body: {
          code: 'MENU_ITEM_VARIANT_REQUIRED',
          error: 'Americano needs a Size.',
          unavailableItems: ['Americano'],
        },
      },
      async (api, calls) => {
        let caught: unknown = null;
        try {
          await api.createPOSOrder('jwt', {
            restaurantId: 'r-1',
            items: [{menuItemId: 'm-americano', name: 'Americano', quantity: 1, basePrice: 0, subtotal: 0}],
            subtotal: 0,
            total: 0,
            idempotencyKey: 'pos_2',
          });
        } catch (e) {
          caught = e;
        }
        return {caught, count: calls.length, ApiRequestError: api.ApiRequestError};
      },
    );
    expect(outcome.caught).toBeInstanceOf(outcome.ApiRequestError);
    expect((outcome.caught as {code?: string}).code).toBe('MENU_ITEM_VARIANT_REQUIRED');
    expect((outcome.caught as Error).message).toBe('Americano needs a Size.');
    expect(outcome.count).toBe(1);
  });
});

describe('POST /api/terminal/rounds carries selectedVariants', () => {
  it('the round body sends each line selection', async () => {
    const item = {id: 'm-americano', name: 'Americano', base_price: 30, variant_groups: [
      {name: 'Size', required: true, type: 'price' as const, options: [
        {label: 'Small', price: 25}, {label: 'Large', price: 45}]},
    ]};
    const lines = addLine([], item, {selectedVariants: {Size: 'Large'}, note: 'extra hot'});

    const body = await withApi(
      {status: 200, body: {order_id: 'o-2', order_number: 8, line_count: 1}},
      async (api, calls) => {
        await api.sendRound(
          {
            tabId: 'tab-1',
            items: buildRoundItems(lines),
            subtotal: 45,
            total: 45,
            idempotencyKey: 'round_1',
          },
          'jwt',
        );
        return JSON.parse(String(calls[0].init.body));
      },
    );
    expect(body.items).toEqual([
      {
        menuItemId: 'm-americano',
        name: 'Americano',
        quantity: 1,
        note: 'extra hot',
        selectedVariants: {Size: 'Large'},
      },
    ]);
  });
});

describe('the variant protocol header (team-lead contract addition)', () => {
  const header = (init: RequestInit) =>
    (init.headers as Record<string, string>)['X-FlashTap-Variant-Protocol'];

  it('POST /api/terminal/orders carries X-FlashTap-Variant-Protocol: 1', async () => {
    const value = await withApi(
      {status: 200, body: {orderId: 'o-1', orderNumber: 7}},
      async (api, calls) => {
        await api.createPOSOrder('jwt', {
          restaurantId: 'r-1',
          items: [{menuItemId: 'm', name: 'Coke', quantity: 1, basePrice: 25, subtotal: 25}],
          subtotal: 25,
          total: 25,
          idempotencyKey: 'pos_h',
        });
        expect(calls[0].url).toMatch(/\/api\/terminal\/orders$/);
        return header(calls[0].init);
      },
    );
    expect(value).toBe('1');
  });

  it('POST /api/terminal/rounds carries X-FlashTap-Variant-Protocol: 1', async () => {
    const value = await withApi(
      {status: 200, body: {order_id: 'o-2', order_number: 8, line_count: 1}},
      async (api, calls) => {
        await api.sendRound(
          {
            tabId: 'tab-1',
            items: [{menuItemId: 'm', name: 'Coke', quantity: 1}],
            subtotal: 25,
            total: 25,
            idempotencyKey: 'round_h',
          },
          'jwt',
        );
        expect(calls[0].url).toMatch(/\/api\/terminal\/rounds$/);
        return header(calls[0].init);
      },
    );
    expect(value).toBe('1');
  });
});
