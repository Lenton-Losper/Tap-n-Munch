import React, {createContext, useContext, useState, useCallback} from 'react';
import {POSOrderItem} from '../lib/api';

interface CartContextValue {
  cart: POSOrderItem[];
  addItem: (item: {id: string; name: string; base_price: number}) => void;
  updateQuantity: (menuItemId: string, delta: number) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

export function CartProvider({children}: {children: React.ReactNode}) {
  const [cart, setCart] = useState<POSOrderItem[]>([]);

  const addItem = useCallback(
    (item: {id: string; name: string; base_price: number}) => {
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
    <CartContext.Provider value={{cart, addItem, updateQuantity, clearCart}}>
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
