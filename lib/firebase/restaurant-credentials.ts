import { getCachedRestaurantCredentials } from '@/lib/cache/restaurant-cache'

export async function getRestaurantFinaticCredentials(restaurantId: string) {
  const restaurant = await getCachedRestaurantCredentials(restaurantId)

  if (!restaurant.finatic_merchant_no || !restaurant.finatic_store_no) {
    throw new Error(`Restaurant ${restaurantId} has no Finatic credentials configured`)
  }

  console.log('[CREDENTIALS] Found:', {
    merchantNo: restaurant.finatic_merchant_no,
    storeNo: restaurant.finatic_store_no,
    terminalSn: restaurant.finatic_terminal_sn,
    checkoutMerchantNo: restaurant.checkout_merchant_no,
    checkoutStoreNo: restaurant.checkout_store_no,
  })

  return {
    merchantNo: restaurant.finatic_merchant_no,
    storeNo: restaurant.finatic_store_no,
    terminalSn: restaurant.finatic_terminal_sn || null,
    checkoutMerchantNo: restaurant.checkout_merchant_no || restaurant.finatic_merchant_no,
    checkoutStoreNo: restaurant.checkout_store_no || restaurant.finatic_store_no,
  }
}
