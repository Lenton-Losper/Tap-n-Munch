const STORAGE_KEY = 'order-idempotency-key'

export function getOrderIdempotencyKey(restaurantId: string, tableNumber: number): string {
  if (typeof window === 'undefined') return ''
  const stored = sessionStorage.getItem(STORAGE_KEY)
  if (stored) return stored
  const key = `${restaurantId}-${tableNumber}-${Date.now()}`
  sessionStorage.setItem(STORAGE_KEY, key)
  return key
}

export function clearOrderIdempotencyKey() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(STORAGE_KEY)
}
