export function getOrCreateCartIdempotencyKey(restaurantId: string, tableNumber: number): string {
  const storageKey = `flashtap_cart_idem_${restaurantId}_${tableNumber}`
  const existing = sessionStorage.getItem(storageKey)
  if (existing) return existing
  const key = crypto.randomUUID()
  sessionStorage.setItem(storageKey, key)
  return key
}

export function clearCartIdempotencyKey(restaurantId: string, tableNumber: number): void {
  const storageKey = `flashtap_cart_idem_${restaurantId}_${tableNumber}`
  sessionStorage.removeItem(storageKey)
}
