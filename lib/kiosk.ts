/**
 * Kiosk utilities — detect kiosk mode from URL params and build kiosk-aware paths.
 */

export function isKioskMode(searchParams: URLSearchParams | null): boolean {
  return searchParams?.get('kiosk') === 'true'
}

export function getKioskName(searchParams: URLSearchParams | null): string {
  return searchParams?.get('name')?.trim() || ''
}

export function kioskSuccessPath(
  restaurantId: string,
  tableParam: string,
  customerName: string,
  orderNumber?: string,
  orderId?: string
): string {
  const base = `/menu/${restaurantId}/kiosk-success?table=${tableParam}&name=${encodeURIComponent(customerName)}`
  const withOrderNumber = orderNumber ? `${base}&orderNumber=${encodeURIComponent(orderNumber)}` : base
  return orderId ? `${withOrderNumber}&orderId=${encodeURIComponent(orderId)}` : withOrderNumber
}

export function kioskResetPath(restaurantId: string, tableParam: string): string {
  return `/menu/${restaurantId}/kiosk?table=${tableParam}&reset=true`
}
