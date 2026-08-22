import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from 'react';
import {POSOrderItem} from '../lib/api';
import {newSaleAttemptKey} from '../lib/saleAttemptKey';

interface CartContextValue {
  cart: POSOrderItem[];
  addItem: (item: {id: string; name: string; base_price: number}) => void;
  updateQuantity: (menuItemId: string, delta: number) => void;
  clearCart: () => void;
  /**
   * #328. Identifies ONE sale attempt. Non-null whenever the cart has items, so the charge path
   * can always send it. Stable across retries of this sale; a different sale gets a different one.
   */
  saleAttemptKey: string | null;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

export function CartProvider({children}: {children: React.ReactNode}) {
  const [cart, setCart] = useState<POSOrderItem[]>([]);
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
    (item: {id: string; name: string; base_price: number}) => {
      // Ringing up the first item starts the sale. `?? existing` keeps it stable for every
      // subsequent item and every retry of this sale.
      setSaleAttemptKey(prev => prev ?? newSaleAttemptKey());
      setCart(prev => {
        const existing = prev.find(i => i.menuItemId === item.id);
        if (existing) {
          return prev.map(i =>
            i.menuItemId === item.id
              ? {
                  ...i,
                  quantity: i.quantity + 1,
                  subtotal: (i.quantity + 1) * i.basePrice,
                }
              : i,
          );
        }
        return [
          ...prev,
          {
            menuItemId: item.id,
            name: item.name,
            quantity: 1,
            basePrice: item.base_price,
            subtotal: item.base_price,
          },
        ];
      });
    },
    [],
  );

  const updateQuantity = useCallback((menuItemId: string, delta: number) => {
    setCart(prev =>
      prev
        .map(item =>
          item.menuItemId === menuItemId
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
