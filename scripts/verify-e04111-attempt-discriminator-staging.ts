/**
 * Staging verification for the E04111 discriminator.
 *
 * Confirms:
 *  1. allocated-only + Finatic E04111 => cancelled with no_payment_attempt_made
 *  2. attempt-started marker present + same E04111 => left pending / skipped uncertain
 *
 * Uses real staging DB rows; only the external Finatic query is stubbed.
 *
 *   npx tsx scripts/verify-e04111-attempt-discriminator-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { autoCancelStalePosOrders, STALE_POS_TIMEOUT_MS } from '../lib/orders/auto-cancel-stale-pos-orders'
import { markPaymentAttemptStarted } from '../lib/payments/mark-payment-attempt-started'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = url
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

function makeE04111Error(merchantOrderNo: string) {
  const err = new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid') as Error & {
    responseBody?: Record<string, unknown>
    phase?: string
  }
  err.responseBody = {
    code: 'E04111',
    msg: '[E04111]Merchant order number is invalid',
    merchant_order_no: merchantOrderNo,
  }
  err.phase = 'business'
  return err
}

async function main() {
  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({
      name: `civ-e04111-${Date.now()}`,
      finatic_merchant_no: 'PROBE_MERCHANT',
      finatic_store_no: 'PROBE_STORE',
    })
    .select('id')
    .single()
  if (restErr || !restaurant?.id) throw restErr ?? new Error('restaurant insert failed')
  const restaurantId = String(restaurant.id)

  const stalePlacedAt = new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString()
  const createdOrderIds: string[] = []

  const createOrder = async (merchantOrderNo: string) => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'card',
        payment_channel: 'card_manual',
        subtotal: 12,
        tax: 0,
        total: 12,
        items: [{ name: merchantOrderNo, quantity: 1, subtotal: 12 }],
        placed_at: stalePlacedAt,
        is_closed: true,
        table_number: 0,
        paycloud_merchant_order_no: merchantOrderNo,
      })
      .select('id')
      .single()
    if (error || !data?.id) throw error ?? new Error('order insert failed')
    const id = String(data.id)
    createdOrderIds.push(id)
    return id
  }

  const allocatedOnlyId = await createOrder('FTE04111ALLOC001')
  const attemptStartedId = await createOrder('FTE04111START002')

  await markPaymentAttemptStarted(admin as any, {
    orderId: attemptStartedId,
    restaurantId,
    businessOrderNo: 'FTE04111START002',
    source: 'terminal_app',
    terminalId: 'probe-terminal',
    terminalSn: 'probe-terminal-sn',
    appVersion: 'probe-1.0.0',
    extraAuditMetadata: { flow: 'staging_test' },
  })

  const result = await autoCancelStalePosOrders(admin as any, {
    restaurantId,
    verifyWithFinatic: true,
    queryFinaticOrderPaidFn: async ({ merchantOrderNo }) => {
      throw makeE04111Error(merchantOrderNo)
    },
  })

  log('autoCancelStalePosOrders result', result)

  const { data: allocatedOnly } = await admin.from('orders').select('*').eq('id', allocatedOnlyId).single()
  const { data: attemptStarted } = await admin.from('orders').select('*').eq('id', attemptStartedId).single()
  log('allocated-only order AFTER', allocatedOnly)
  log('attempt-started order AFTER', attemptStarted)

  assert(
    allocatedOnly?.status === 'cancelled' &&
      allocatedOnly?.payment_status === 'cancelled' &&
      allocatedOnly?.cancellation_reason === 'no_payment_attempt_made',
    `allocated-only order wrong state: ${JSON.stringify(allocatedOnly)}`,
  )
  assert(
    attemptStarted?.status === 'pending' &&
      attemptStarted?.payment_status === 'pending',
    `attempt-started order wrong state: ${JSON.stringify(attemptStarted)}`,
  )
  assert(result.cancelledIds.includes(allocatedOnlyId), 'allocated-only id missing from cancelledIds')
  assert(!result.cancelledIds.includes(attemptStartedId), 'attempt-started id must not be cancelled')
  assert(result.skippedUncertainIds.includes(attemptStartedId), 'attempt-started id must be skipped uncertain')

  const { data: cancelAudit } = await admin
    .from('audit_logs')
    .select('*')
    .eq('entity_id', allocatedOnlyId)
    .eq('action', 'order.cancelled')
  log('allocated-only cancel audit', cancelAudit)
  assert(
    (cancelAudit ?? []).some((row: any) => row?.metadata?.source === 'auto_cancel_cron_no_payment_attempt'),
    'allocated-only order missing auto_cancel_cron_no_payment_attempt audit',
  )

  const { data: startAudit } = await admin
    .from('audit_logs')
    .select('*')
    .eq('entity_id', attemptStartedId)
    .eq('action', 'payment.attempt_started')
  log('attempt-started audit', startAudit)
  assert((startAudit?.length ?? 0) === 1, 'attempt-started order missing payment.attempt_started audit')

  console.log('\nVERIFY_E04111_ATTEMPT_DISCRIMINATOR_STAGING_OK')

  await admin.from('audit_logs').delete().in('entity_id', createdOrderIds)
  await admin.from('receipt_documents').delete().in('order_id', createdOrderIds)
  await admin.from('orders').delete().in('id', createdOrderIds)
  await admin.from('restaurants').delete().eq('id', restaurantId)
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
