/** Onboarding QR URL format: /menu/{restaurantId}/v2?table={tableNumber} */
export function buildOnboardingTableQrUrl(
  restaurantId: string,
  tableNumber: number
): string {
  return `https://www.flashtap.app/menu/${restaurantId}/v2?table=${tableNumber}`
}
