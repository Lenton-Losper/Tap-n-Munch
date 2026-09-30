/**
 * RC SPRINT 2026-09-30 — A4/A5 ON THE POS PATH. The real POSCartScreen, the real CartProvider and
 * the real lib/api.ts createPOSOrder; only fetch, navigation and the native stores are faked.
 *
 * The fake answers as app/api/terminal/orders/route.ts POST does (web 5d6f2bc4): a repeat of a key
 * returns the SAME order `{success, orderId, orderNumber, duplicate: true}`.
 *
 * WHY A DOUBLE TAP MATTERS HERE even though the server dedupes on the key: each successful answer
 * calls navigation.replace('Payment', ...). Two concurrent requests are two replaces -- the Charge
 * screen for the same order mounted twice, the first torn down under whatever it had started.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert} from 'react-native';

const mockNavigation = {replace: jest.fn(), goBack: jest.fn(), navigate: jest.fn()};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({params: {restaurantId: 'r-1'}}),
}));

import POSCartScreen from '../POSCartScreen';
import {CartProvider, useCart} from '../../context/CartContext';

type Posted = {key: string | null; body: Record<string, unknown>};
let posts: Posted[] = [];
const held: Array<() => void> = [];
const keys = new Map<string, {orderId: string; orderNumber: number}>();

function res(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => 'application/json'},
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

beforeAll(() => {
  const encrypted = require('react-native-encrypted-storage').default as {getItem: jest.Mock};
  encrypted.getItem.mockImplementation(async (key: string) =>
    key === 'flashtap_terminal_token' ? 'rc-terminal-token' : null,
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  posts = [];
  held.splice(0);
  keys.clear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (globalThis as unknown as {fetch: unknown}).fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/terminal/orders') {
      return res(404, {error: 'unrouted'});
    }
    const key = ((init?.headers ?? {}) as Record<string, string>)['x-idempotency-key'] ?? null;
    posts.push({key, body: JSON.parse(String(init?.body))});
    return new Promise<Response>(resolve => {
      held.push(() => {
        const prior = key ? keys.get(key) : undefined;
        if (prior) {
          resolve(res(200, {success: true, ...prior, duplicate: true}));
          return;
        }
        const created = {orderId: `o-${keys.size + 1}`, orderNumber: 500 + keys.size};
        if (key) {
          keys.set(key, created);
        }
        resolve(res(200, {success: true, ...created, duplicate: false}));
      });
    });
  };
});

type Cart = ReturnType<typeof useCart>;
const cartRef: {current: Cart | null} = {current: null};
function Capture() {
  cartRef.current = useCart();
  return null;
}

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <CartProvider>
        <Capture />
        <POSCartScreen />
      </CartProvider>,
    );
  });
  await act(async () => {
    cartRef.current!.addItem({id: 'm-latte', name: 'Latte', base_price: 35});
  });
  await flush();
  return tree;
}

function renderedText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  const el = node as {props?: {children?: unknown}};
  return renderedText(el.props?.children ?? null);
}

function chargeButton(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      typeof n.props?.onPress === 'function' &&
      renderedText(n.props.children).includes('Charge'),
  )[0];
}

describe('POS Charge — A4 double tap', () => {
  it('MUTATION GUARD (A4-POS): two presses in one batch create ONE request and ONE navigation to Payment', async () => {
    const tree = await mount();
    const button = chargeButton(tree);
    await act(async () => {
      void button.props.onPress();
      void button.props.onPress();
      await Promise.resolve();
    });
    await flush();
    expect(posts).toHaveLength(1);
    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith(
      'Payment',
      expect.objectContaining({orderId: 'o-1'}),
    );
  });

  it('A5-POS: the quantity cannot be changed while the order is being created', async () => {
    const tree = await mount();
    await act(async () => {
      void chargeButton(tree).props.onPress();
      await Promise.resolve();
    });
    await flush();
    const steppers = tree.root.findAll(
      n =>
        typeof n.props?.onPress === 'function' &&
        (renderedText(n.props.children).includes('−') ||
          renderedText(n.props.children).includes('+')) &&
        !renderedText(n.props.children).includes('Charge'),
    );
    expect(steppers.length).toBeGreaterThan(0);
    for (const s of steppers) {
      expect(s.props.disabled).toBe(true);
    }
    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
  });

  it('A2-POS: a retry after a lost answer reuses the key and gets the SAME order back', async () => {
    const tree = await mount();
    // First attempt: the server creates the order, the answer never arrives.
    (globalThis as unknown as {fetch: unknown}).fetch = (() => {
      const original = (globalThis as unknown as {fetch: (i: string, n?: RequestInit) => Promise<Response>}).fetch;
      let first = true;
      return async (input: string, init?: RequestInit) => {
        const p = original(input, init);
        if (first) {
          first = false;
          held.shift()!();
          await p;
          throw new TypeError('Network request failed');
        }
        return p;
      };
    })();
    await act(async () => {
      await chargeButton(tree).props.onPress();
    });
    await flush();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(cartRef.current!.cart).toHaveLength(1); // the sale survives the failure

    await act(async () => {
      void chargeButton(tree).props.onPress();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      held.splice(0).forEach(release => release());
    });
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1].key).toBe(posts[0].key);
    expect(keys.size).toBe(1);
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Payment', expect.objectContaining({orderId: 'o-1'}));
  });
});
