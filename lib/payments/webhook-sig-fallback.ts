import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  queryFinaticOrderPaid,
  type FinaticOrderPaidResult,
} from '@/lib/payments/query-finatic-order-paid'
import { stagingFinaticQueryStub } from '@/lib/payments/staging-finatic-stub'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type WebhookSigFallbackPath =
  | 'fallback_verified_paid'
  | 'fallback_verified_not_paid'
  | 'fallback_query_failed'
  | 'fallback_already_paid'

export type WebhookSigFallbackResult =
  | {
      path: 'fallback_verified_paid'
      finatic: FinaticOrderPaidResult
      orderIds: string[]
      restaurantId: string
      orderTotal: number
    }
  | {
      path: 'fallback_verified_not_paid'
      finatic: FinaticOrderPaidResult
      orderIds: string[]
    }
  | {
      path: 'fallback_already_paid'
      orderIds: string[]
    }
  | {
      path: 'fallback_query_failed'
      reason: string
      orderIds: string[]
    }

/**
 * After webhook RSA/HMAC signature check fails, independently ask Finatic whether
 * the merchant_order_no is paid. Never trusts the webhook payload's paid claims.
 */
export async function confirmWebhookOrderViaFinaticFallback(params: {
  supabase: Supabase
  merchantOrderNo: string
  orderIds: string[]
  /** Staging-only stub mode from request body; ignored in production. */
  stagingFinaticStub?: unknown
}): Promise<WebhookSigFallbackResult> {
  const merchantOrderNo = params.merchantOrderNo.trim()
  const orderIds = params.orderIds

  if (!orderIds.length) {
    return {
      path: 'fallback_query_failed',
      reason: 'No local order for merchant_order_no; cannot resolve restaurant Finatic credentials',
      orderIds: [],
    }
  }

  const { data: orders, error: ordersError } = await params.supabase
    .from('orders')
    .select('id, restaurant_id, total, payment_status')
    .in('id', orderIds)

  if (ordersError) {
    return {
      path: 'fallback_query_failed',
      reason: `Failed to load orders for fallback: ${ordersError.message}`,
      orderIds,
    }
  }

  const rows = orders ?? []
  if (
    rows.length > 0 &&
    rows.every((r) => String(r.payment_status || '').toLowerCase() === 'paid')
  ) {
    return { path: 'fallback_already_paid', orderIds: rows.map((r) => String(r.id)) }
  }

  const pendingOrOther = rows.filter(
    (r) => String(r.payment_status || '').toLowerCase() !== 'paid',
  )
  const primary = pendingOrOther[0] ?? rows[0]
  if (!primary?.restaurant_id) {
    return {
      path: 'fallback_query_failed',
      reason: 'Order row missing restaurant_id for Finatic credential lookup',
      orderIds,
    }
  }

  const restaurantId = String(primary.restaurant_id)
  const orderTotal = Number(primary.total) || 0

  const stubFn = stagingFinaticQueryStub(params.stagingFinaticStub)
  const queryFn = stubFn ?? queryFinaticOrderPaid

  try {
    let merchantNo = 'STAGING_STUB'
    let storeNo = 'STAGING_STUB'
    if (!stubFn) {
      const creds = await getRestaurantFinaticCredentials(restaurantId)
      merchantNo = creds.merchantNo
      storeNo = creds.storeNo
    } else {
      try {
        const creds = await getRestaurantFinaticCredentials(restaurantId)
        merchantNo = creds.merchantNo
        storeNo = creds.storeNo
      } catch {
        // Staging fixtures often lack Finatic creds; stub does not need them.
      }
    }

    const finatic = await queryFn({ merchantOrderNo, merchantNo, storeNo })
    if (finatic.paid) {
      return {
        path: 'fallback_verified_paid',
        finatic,
        orderIds: pendingOrOther.map((r) => String(r.id)),
        restaurantId,
        orderTotal: finatic.amount ?? orderTotal,
      }
    }
    return {
      path: 'fallback_verified_not_paid',
      finatic,
      orderIds: pendingOrOther.map((r) => String(r.id)),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { path: 'fallback_query_failed', reason, orderIds }
  }
}
