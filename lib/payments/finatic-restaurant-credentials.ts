import { getCachedRestaurantCredentials } from '@/lib/cache/restaurant-cache'

export async function getRestaurantFinaticCredentials(
  restaurantId: string
): Promise<{
  merchantNo: string
  storeNo: string
  terminalSn: string | null
  checkoutMerchantNo: string
  checkoutStoreNo: string
}> {
  const data = await getCachedRestaurantCredentials(restaurantId)

  const merchantNo = String(data?.merchantNo || '').trim()
  const storeNo = String(data?.storeNo || '').trim()
  const terminalSn = data?.terminalSn ? String(data.terminalSn).trim() : null
  const checkoutMerchantNo = String(data?.checkoutMerchantNo || '').trim()
  const checkoutStoreNo = String(data?.checkoutStoreNo || '').trim()

  if (!merchantNo || !storeNo) {
    throw new Error(`No Finatic credentials configured for restaurant`)
  }

  return { merchantNo, storeNo, terminalSn, checkoutMerchantNo, checkoutStoreNo }
}
