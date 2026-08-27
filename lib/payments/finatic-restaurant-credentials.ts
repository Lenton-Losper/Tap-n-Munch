import { getCachedRestaurantCredentials } from '@/lib/cache/restaurant-cache'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'

export {
  isMissingFinaticCredentialsError,
  MISSING_FINATIC_CREDENTIALS_MESSAGE,
  MissingFinaticCredentialsError,
} from '@/lib/payments/finatic-credentials-error'

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
    /**
     * #153. A TYPED throw, same message. Callers that only read `.message` are unaffected; the
     * two that must tell this apart from an unreachable gateway now can, without string-matching
     * at the call site. See finatic-credentials-error.ts for why the class lives in its own file.
     */
    throw new MissingFinaticCredentialsError(restaurantId)
  }

  return { merchantNo, storeNo, terminalSn, checkoutMerchantNo, checkoutStoreNo }
}
