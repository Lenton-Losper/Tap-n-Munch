import { NextResponse } from 'next/server'
import { queryPaymentOrder } from '@/payments/paycloud'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'

/**
 * Staging-only PayCloud order query for support debugging.
 * Merchant/store credentials are loaded server-side when restaurantId is provided;
 * client merchantNo/storeNo overrides are ignored.
 */
export async function GET(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get('orderId')
  const restaurantId = searchParams.get('restaurantId') || undefined

  if (!orderId) {
    return NextResponse.json({ error: 'orderId required' }, { status: 400 })
  }

  try {
    let merchantNo: string | undefined
    let storeNo: string | undefined
    if (restaurantId) {
      const creds = await getRestaurantFinaticCredentials(restaurantId)
      merchantNo = creds.merchantNo
      storeNo = creds.storeNo
    }
    const result = await queryPaymentOrder({ orderId, merchantNo, storeNo })
    return NextResponse.json({ result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Query failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
