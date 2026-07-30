import type { createServerSupabaseClient } from '@/lib/supabase/server'

/** PayCloud/Finatic wire limit for merchant_order_no. */
export const TERMINAL_MERCHANT_ORDER_NO_MAX_LEN = 32

/**
 * PayCloud allowed charset: numbers, letters, and _-|*@.
 * Matches payments/paycloud.js paycloudWireMerchantOrderNo constraints.
 */
const PAYCLOUD_MERCHANT_ORDER_NO_ALLOWED_RE = /^[0-9A-Za-z_\-\*@]+$/

export function isPaycloudSafeMerchantOrderNo(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TERMINAL_MERCHANT_ORDER_NO_MAX_LEN &&
    PAYCLOUD_MERCHANT_ORDER_NO_ALLOWED_RE.test(value)
  )
}

/**
 * Backend-owned merchant order number for terminal POS Finatic SALE.
 * Format: FT + millis + 4-digit random, truncated to 32 (same family as push-to-terminal).
 * Deliberately not derived from the device UUID+timestamp scheme — the backend is the
 * single source of truth and the value is persisted on orders.paycloud_merchant_order_no
 * before the terminal launches WiseCashier.
 */
export function generateTerminalMerchantOrderNo(nowMs: number = Date.now()): string {
  const rand4 = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `FT${nowMs}${rand4}`.slice(0, TERMINAL_MERCHANT_ORDER_NO_MAX_LEN)
}

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * Ensures orders.paycloud_merchant_order_no is set for an unpaid order and returns it.
 *
 * Reuses an existing non-null value when present so a Finatic notify for the in-flight
 * attempt still correlates if prepare is called more than once. Mints a new unique value
 * only when the column is null. Does not rotate on every call (that would orphan webhooks
 * for the previous businessOrderNo).
 */
export async function ensureTerminalMerchantOrderNo(
  supabase: Supabase,
  params: { orderId: string; restaurantId: string },
): Promise<{ merchantOrderNo: string; created: boolean }> {
  const { orderId, restaurantId } = params

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, payment_status, paycloud_merchant_order_no')
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (orderError) {
    throw new Error(`Failed to load order: ${orderError.message}`)
  }
  if (!order) {
    const notFound = new Error('Order not found')
    ;(notFound as Error & { status: number }).status = 404
    throw notFound
  }

  const paymentStatus = String(order.payment_status || '').toLowerCase()
  if (paymentStatus === 'paid') {
    const alreadyPaid = new Error('Order is already paid')
    ;(alreadyPaid as Error & { status: number; code: string }).status = 400
    ;(alreadyPaid as Error & { code: string }).code = 'ALREADY_PAID'
    throw alreadyPaid
  }
  if (paymentStatus === 'cancelled') {
    const cancelled = new Error('Order is cancelled')
    ;(cancelled as Error & { status: number; code: string }).status = 400
    ;(cancelled as Error & { code: string }).code = 'ORDER_CANCELLED'
    throw cancelled
  }

  // Reusability is judged against the UNTRIMMED stored value, deliberately.
  //
  // Trimming first meant a padded value such as '  FT1700000000001  ' was judged safe and
  // reused: callers transmitted the TRIMMED form to Finatic while the column kept the PADDED
  // form, and resolveOrderIdsByMerchantOrderNo (resolve-order-by-merchant-order.ts:14-20)
  // matches byte-exact — so the notify could never correlate. Money taken, order left unpaid,
  // which is the same orphaned-webhook failure this helper's no-rotation rule exists to
  // prevent. A value that differs from its own trimmed form is therefore NOT reusable.
  const rawExisting = String(order.paycloud_merchant_order_no ?? '')
  const existing = rawExisting.trim()
  if (existing !== '' && existing === rawExisting && isPaycloudSafeMerchantOrderNo(existing)) {
    return { merchantOrderNo: existing, created: false }
  }

  // Unique partial index on paycloud_merchant_order_no — retry on rare collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const merchantOrderNo = generateTerminalMerchantOrderNo()

    // Compare-and-swap against whatever is actually stored. Guarding only on NULL would make
    // an unusable non-null value (padded, or otherwise unsafe) unreplaceable: `.eq()` is
    // byte-exact, so the trimmed form would never match a padded row and every attempt would
    // fall through to the retry loop and ultimately throw.
    const persistQuery = supabase
      .from('orders')
      .update({ paycloud_merchant_order_no: merchantOrderNo })
      .eq('id', orderId)
      .eq('restaurant_id', restaurantId)
    const guarded =
      rawExisting !== ''
        ? persistQuery.eq('paycloud_merchant_order_no', rawExisting)
        : persistQuery.is('paycloud_merchant_order_no', null)

    const { data: updated, error: updateError } = await guarded
      .select('paycloud_merchant_order_no')
      .maybeSingle()

    if (!updateError && updated?.paycloud_merchant_order_no) {
      return {
        merchantOrderNo: String(updated.paycloud_merchant_order_no),
        created: true,
      }
    }

    if (updateError && !isUniqueViolation(updateError)) {
      throw new Error(`Failed to persist merchant order no: ${updateError.message}`)
    }

    // Lost race to another prepare, or unique collision — re-read.
    const { data: again, error: againError } = await supabase
      .from('orders')
      .select('paycloud_merchant_order_no')
      .eq('id', orderId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (againError) {
      throw new Error(`Failed to re-load order: ${againError.message}`)
    }
    const after = String(again?.paycloud_merchant_order_no || '').trim()
    if (after && isPaycloudSafeMerchantOrderNo(after)) {
      return { merchantOrderNo: after, created: false }
    }
  }

  throw new Error('Failed to allocate a unique merchant order no')
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' || Boolean(error?.message?.includes('duplicate key'))
}
