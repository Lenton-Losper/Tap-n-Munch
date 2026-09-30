/**
 * getOrder() asks the server for ONE order (Payment screen performance, 2026-09-30).
 *
 * getOrder(orderId) used to call getOrders(): GET /api/terminal/orders with no parameters, which
 * returns every live order for the restaurant -- 4,675 rows / 11.8 MB at FNB ChowNow -- so that the
 * device could Array.find one. The Payment screen waited on that for its total (p90 >= 13 s).
 *
 * These are asserted against the ACTUAL fetch call: a getOrder that quietly went back to fetching
 * the list would still return the right order, and only the URL shows the difference.
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

const BASE = 'https://example.invalid';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function row(id: string, total = 5) {
  return {
    id,
    restaurant_id: 'r1',
    order_number: 59,
    status: 'pending',
    total,
    items: [{name: 'Espresso', quantity: 1, price: total}],
    tab_id: null,
    placed_at: '2026-09-30T07:40:44.238Z',
  };
}

describe('getOrder: one order requested -> one order asked for', () => {
  it('sends GET /api/terminal/orders?orderId=<id>, once, and nothing else', async () => {
    const calls = await withApi({status: 200, body: {orders: [row(ORDER_ID)]}}, async (api, seen) => {
      await api.getOrder(ORDER_ID, 'tok');
      return seen;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/terminal/orders?orderId=${ORDER_ID}`);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
  });

  it('URL-encodes the id, so it can only ever be one parameter', async () => {
    const odd = 'a&status=paid';
    const calls = await withApi({status: 200, body: {orders: [row(odd)]}}, async (api, seen) => {
      await api.getOrder(odd, 'tok');
      return seen;
    });
    expect(calls[0].url).toBe(`${BASE}/api/terminal/orders?orderId=${encodeURIComponent(odd)}`);
  });

  it('returns the requested order, mapped', async () => {
    const order = await withApi({status: 200, body: {orders: [row(ORDER_ID, 5)]}}, api =>
      api.getOrder(ORDER_ID, 'tok'),
    );
    expect(order.id).toBe(ORDER_ID);
    expect(order.total).toBe(5);
    expect(order.order_number).toBe(59);
  });

  it('an empty answer (missing, or another venue\'s order) still reads as "Order not found"', async () => {
    await expect(
      withApi({status: 200, body: {orders: []}}, api => api.getOrder(ORDER_ID, 'tok')),
    ).rejects.toThrow('Order not found');
  });

  it('COMPATIBILITY: a worker that ignores ?orderId answers with the list, and the right order is still picked', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const order = await withApi(
      {status: 200, body: {orders: [row(other, 90), row(ORDER_ID, 5), row('x', 1), row('y', 2)]}},
      api => api.getOrder(ORDER_ID, 'tok'),
    );
    // By id, never "the first row": an older worker's list does not start with the one asked for.
    expect(order.id).toBe(ORDER_ID);
    expect(order.total).toBe(5);
  });

  it('a refusal from the server is still an error, not an empty order', async () => {
    await expect(
      withApi(
        {status: 400, body: {error: 'orderId must be a UUID', code: 'INVALID_ORDER_ID'}},
        api => api.getOrder(ORDER_ID, 'tok'),
      ),
    ).rejects.toMatchObject({status: 400, code: 'INVALID_ORDER_ID'});
  });
});

describe('getOrders: the list call is unchanged', () => {
  it('still sends GET /api/terminal/orders with no parameters and returns every row', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const {orders, calls} = await withApi(
      {status: 200, body: {orders: [row(ORDER_ID), row(other)]}},
      async (api, seen) => ({orders: await api.getOrders('tok'), calls: seen}),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/terminal/orders`);
    expect(orders.map(o => o.id)).toEqual([ORDER_ID, other]);
  });
});
