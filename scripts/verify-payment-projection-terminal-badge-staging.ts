/**
 * Staging verification for the backend half of #29 ("Terminal still shows
 * PAID badge on tab rows after a refund").
 *
 * Confirms lib/payments/get-payment-projection.ts (consumed by
 * app/api/terminal/tables/route.ts as `payment_status_derived` /
 * `refunded_amount`) correctly derives 'refunded' / 'partially_refunded'
 * from the append-only payment_events ledger — the data a Terminal client
 * would need to stop showing a plain PAID badge post-refund.
 *
 * Scope note: the actual "PAID" badge lives in the Terminal app UI, which is
 * a separate repository (Lenton-Losper/Flashtap-Staff), not Tap-n-Munch —
 * see the #29 issue comment for details. This script only verifies the
 * Tap-n-Munch backend piece.
 *
 *   npx tsx scripts/verify-payment-projection-terminal-badge-staging.ts
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  let restaurantId: string | null = null

  console.log(`[${ts()}] === Payment projection / terminal badge data staging verification (#29) ===`)

  try {
    const { data: restaurant, error: restErr } = await admin
      .from('restaurants')
      .insert({ name: `Payment Projection Badge Test ${tag}`, currency: 'NAD' })
      .select('id')
      .single()
    if (restErr || !restaurant?.id) throw restErr || new Error('restaurant insert failed')
    restaurantId = String(restaurant.id)

    const orderId = randomUUID()
    const businessOrderNo = `TEST-${tag}`

    // Fully paid order, no refund yet.
    const { error: saleError } = await admin.from('payment_events').insert({
      restaurant_id: restaurantId,
      event_type: 'sale',
      business_order_no: businessOrderNo,
      origin_business_order_no: businessOrderNo,
      order_ids: [orderId],
      amount: 100,
      currency: 'NAD',
      idempotency_key: `sale-${tag}`,
      reason_code: 'n/a',
    })
    if (saleError) throw saleError

    let projections = await getPaymentProjections(admin as any, restaurantId, [orderId])
    let projection = projections.get(orderId)
    await assert(projection?.paymentStatus === 'paid', 'no refund yet: paymentStatus = paid')
    await assert(projection?.refundedAmount === 0, 'no refund yet: refundedAmount = 0')

    // Partial refund.
    const { error: partialRefundError } = await admin.from('payment_events').insert({
      restaurant_id: restaurantId,
      event_type: 'refund_succeeded',
      business_order_no: `${businessOrderNo}-R1`,
      origin_business_order_no: businessOrderNo,
      order_ids: [orderId],
      amount: 30,
      currency: 'NAD',
      idempotency_key: `refund-partial-${tag}`,
      reason_code: 'customer_request',
    })
    if (partialRefundError) throw partialRefundError

    projections = await getPaymentProjections(admin as any, restaurantId, [orderId])
    projection = projections.get(orderId)
    await assert(
      projection?.paymentStatus === 'partially_refunded',
      `partial refund: paymentStatus = partially_refunded (got ${projection?.paymentStatus})`,
    )
    await assert(projection?.refundedAmount === 30, `partial refund: refundedAmount = 30 (got ${projection?.refundedAmount})`)

    // Full refund (remaining 70).
    const { error: fullRefundError } = await admin.from('payment_events').insert({
      restaurant_id: restaurantId,
      event_type: 'refund_succeeded',
      business_order_no: `${businessOrderNo}-R2`,
      origin_business_order_no: businessOrderNo,
      order_ids: [orderId],
      amount: 70,
      currency: 'NAD',
      idempotency_key: `refund-full-${tag}`,
      reason_code: 'customer_request',
    })
    if (fullRefundError) throw fullRefundError

    projections = await getPaymentProjections(admin as any, restaurantId, [orderId])
    projection = projections.get(orderId)
    await assert(
      projection?.paymentStatus === 'refunded',
      `full refund: paymentStatus = refunded (got ${projection?.paymentStatus}) — this is the exact state #29's Terminal UI needs to distinguish from PAID`,
    )
    await assert(projection?.refundedAmount === 100, `full refund: refundedAmount = 100 (got ${projection?.refundedAmount})`)

    console.log(`\n[${ts()}] Payment projection verification passed.`)
    console.log(
      `[${ts()}] Backend data is correct and already exposed via app/api/terminal/tables ` +
        `(payment_status_derived, refunded_amount). The remaining #29 work — rendering a ` +
        `REFUNDED badge instead of PAID — is in the Terminal app UI, a separate repo ` +
        `(Lenton-Losper/Flashtap-Staff), out of scope here.`,
    )
  } finally {
    if (restaurantId) {
      await admin.from('payment_events').delete().eq('restaurant_id', restaurantId)
      await admin.from('restaurants').delete().eq('id', restaurantId)
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
