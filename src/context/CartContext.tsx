import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from 'react';
import {POSOrderItem} from '../lib/api';
import {newSaleAttemptKey} from '../lib/saleAttemptKey';
import {
  canonicalSelection,
  hasSelection,
  isSelectionComplete,
  variantDisplayName,
  variantLineKey,
  variantUnitPrice,
  type VariantPricedItem,
  type VariantSelection,
} from '../lib/variantPricing';

/**
 * One cart line. A line is a menu item AND its variant selection: two sizes of the same coffee are
 * two lines, each at its own price (Sprint 2026-09-28 brief). `lineKey` is that identity; for an
 * item with no selection it is the menu item id, exactly as lines were keyed before variants.
 */
export interface CartLine extends POSOrderItem {
  lineKey: string;
  /** "Americano - Large" -- what the waiter sees; `name` stays the menu item's own name. */
  displayName: string;
}

/**
 * The wire shape for POST /api/terminal/orders. Strips the device-only fields and sends
 * `selectedVariants` only when the line has one (C6), so a plain item's payload is unchanged.
 */
export function buildPOSOrderItems(cart: CartLine[]): POSOrderItem[] {
  return cart.map(line => ({
    menuItemId: line.menuItemId,
    name: line.name,
    quantity: line.quantity,
    basePrice: line.basePrice,
    subtotal: line.subtotal,
    ...(hasSelection(line.selectedVariants)
      ? {selectedVariants: {...line.selectedVariants}}
      : {}),
  }));
}

/**
 * Pure cart add, so the merge rule is testable without a React tree.
 *
 * REFUSES (returns the cart unchanged) when a required variant group is unanswered. The picker
 * already disables Add in that state; this is the second lock, so no other caller can put a line
 * in the cart that the server would refuse -- or, on a zero-base item, show at N$0.00.
 */
export function addCartLine(
  cart: CartLine[],
  item: VariantPricedItem,
  selection?: VariantSelection,
): CartLine[] {
  if (!isSelectionComplete(item, selection)) {
    return cart;
  }
  const selectedVariants = canonicalSelection(item, selection);
  const lineKey = variantLineKey(item.id, selectedVariants);
  const unit = variantUnitPrice(item, selectedVariants);
  const existing = cart.find(i => i.lineKey === lineKey);
  if (existing) {
    return cart.map(i =>
      i.lineKey === lineKey
        ? {...i, quantity: i.quantity + 1, subtotal: (i.quantity + 1) * i.basePrice}
        : i,
    );
  }
  return [
    ...cart,
    {
      lineKey,
      menuItemId: item.id,
      name: item.name,
      displayName: variantDisplayName(item.name, selectedVariants),
      quantity: 1,
      basePrice: unit,
      subtotal: unit,
      ...(hasSelection(selectedVariants) ? {selectedVariants} : {}),
    },
  ];
}

interface CartContextValue {
  cart: CartLine[];
  /** `selection` is required for an item with required variant groups; see addCartLine. */
  addItem: (item: VariantPricedItem, selection?: VariantSelection) => void;
  /** Keyed by LINE (`CartLine.lineKey`) -- which is the menu item id for a line with no variant. */
  updateQuantity: (lineKey: string, delta: number) => void;
  clearCart: () => void;
  /**
   * #328. Identifies ONE sale attempt. Non-null whenever the cart has items, so the charge path
   * can always send it. Stable across retries of this sale; a different sale gets a different one.
   */
  saleAttemptKey: string | null;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

export function CartProvider({children}: {children: React.ReactNode}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [saleAttemptKey, setSaleAttemptKey] = useState<string | null>(null);

  /**
   * The key's lifetime IS the cart's. An empty cart means the sale ended -- charged, abandoned, or
   * emptied item by item -- so the next one must not reuse this key or the server would answer the
   * new sale with the OLD order. Expressed as an effect rather than inside clearCart so that
   * emptying via updateQuantity is covered by the same rule.
   */
  useEffect(() => {
    if (cart.length === 0) {
      setSaleAttemptKey(null);
    }
  }, [cart.length]);

  const addItem = useCallback(
    (item: VariantPricedItem, selection?: VariantSelection) => {
      if (!isSelectionComplete(item, selection)) {
        return;
      }
      // Ringing up the first item starts the sale. `?? existing` keeps it stable for every
      // subsequent item and every retry of this sale.
      setSaleAttemptKey(prev => prev ?? newSaleAttemptKey());
      setCart(prev => addCartLine(prev, item, selection));
    },
    [],
  );

  const updateQuantity = useCallback((lineKey: string, delta: number) => {
    setCart(prev =>
      prev
        .map(item =>
          item.lineKey === lineKey
            ? {
                ...item,
                quantity: item.quantity + delta,
                subtotal: (item.quantity + delta) * item.basePrice,
              }
            : item,
        )
        .filter(item => item.quantity > 0),
    );
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  return (
    <CartContext.Provider value={{cart, addItem, updateQuantity, clearCart, saleAttemptKey}}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return ctx;
}
