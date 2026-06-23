import { getQRCodeBaseUrl } from '@/lib/base-url'

/** Onboarding QR URL format: /table/{tableNumber}?r={restaurantId} */
export function buildOnboardingTableQrUrl(restaurantId: string, tableNumber: number): string {
  const baseUrl = getQRCodeBaseUrl() || 'https://www.flashtap.app'
  return `${baseUrl}/table/${tableNumber}?r=${restaurantId}`
}
