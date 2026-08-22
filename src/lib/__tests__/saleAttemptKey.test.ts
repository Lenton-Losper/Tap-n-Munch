import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {CartProvider, useCart} from '../../context/CartContext';
import {newSaleAttemptKey} from '../saleAttemptKey';

/**
 * #328 — the key identifies ONE SALE ATTEMPT.
 *
 * The whole point is a lifetime, not a value, so that is what is asserted here. Two failure modes
 * are equally bad and they pull in opposite directions:
 *
 *   too STABLE  — a key that outlives its sale makes the server answer the NEXT sale with the
 *                 PREVIOUS order. The customer is charged for a cart they did not order.
 *   too FRESH   — a key regenerated per request is the same as sending none, which is the defect
 *                 (0 of 1545 production POS orders carried one), and every retry strands a row the
 *                 stale-order cron can never clean up.
 *
 * So every test below pins one edge of that window, and the last two are the ones that would catch
 * a regression in either direction.
 */
const COFFEE = {id: 'menu-1', name: 'Coffee', base_price: 25};
const TEA = {id: 'menu-2', name: 'Tea', base_price: 18};

/** Renders the provider and hands back a live handle on the context. */
function mountCart() {
  const seen: {current: ReturnType<typeof useCart> | null} = {current: null};
  function Probe() {
    seen.current = useCart();
    return null;
  }
  act(() => {
    TestRenderer.create(
      React.createElement(CartProvider, null, React.createElement(Probe)),
    );
  });
  return {
    get: () => {
      if (!seen.current) {
        throw new Error('cart context not mounted');
      }
      return seen.current;
    },
  };
}

describe('newSaleAttemptKey', () => {
  it('does not collide across a burst', () => {
    // Same millisecond for many of these, so the randomness is what is actually being checked.
    const keys = new Set(Array.from({length: 5000}, () => newSaleAttemptKey()));
    expect(keys.size).toBe(5000);
  });
});

describe('the key lives exactly as long as the sale', () => {
  it('is null before anything is rung up', () => {
    const cart = mountCart();
    expect(cart.get().saleAttemptKey).toBeNull();
  });

  it('exists as soon as the first item is rung up', () => {
    const cart = mountCart();
    act(() => cart.get().addItem(COFFEE));
    expect(typeof cart.get().saleAttemptKey).toBe('string');
    expect(cart.get().saleAttemptKey).not.toBe('');
  });

  it('does NOT change as more items are added to the same sale', () => {
    // A key that changed here would send a different key on every retry, which is the same as
    // sending none at all.
    const cart = mountCart();
    act(() => cart.get().addItem(COFFEE));
    const first = cart.get().saleAttemptKey;
    act(() => cart.get().addItem(TEA));
    act(() => cart.get().addItem(COFFEE));
    expect(cart.get().saleAttemptKey).toBe(first);
  });

  it('is dropped when the sale completes', () => {
    const cart = mountCart();
    act(() => cart.get().addItem(COFFEE));
    act(() => cart.get().clearCart());
    expect(cart.get().saleAttemptKey).toBeNull();
  });

  it('is dropped when the sale is abandoned item by item', () => {
    // Emptying the cart with the quantity control never calls clearCart, so a key tied only to
    // clearCart would survive into the next sale.
    const cart = mountCart();
    act(() => cart.get().addItem(COFFEE));
    act(() => cart.get().updateQuantity(COFFEE.id, -1));
    expect(cart.get().cart).toHaveLength(0);
    expect(cart.get().saleAttemptKey).toBeNull();
  });

  it('the NEXT sale gets a different key', () => {
    // The failure this catches is the expensive one: reusing a key across sales makes the server
    // answer the new sale with the previous order.
    const cart = mountCart();
    act(() => cart.get().addItem(COFFEE));
    const first = cart.get().saleAttemptKey;
    act(() => cart.get().clearCart());
    act(() => cart.get().addItem(TEA));
    const second = cart.get().saleAttemptKey;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
