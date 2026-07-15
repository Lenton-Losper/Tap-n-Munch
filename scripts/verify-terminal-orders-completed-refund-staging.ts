/**
 * Staging verification for the #26 follow-up fix to GET /api/terminal/orders.
 *
 * Confirms:
 *  1. A real 'completed' standalone (table_number 0, individually-paid) order is now
 *     returned by the endpoint (previously excluded by the .in('status', [...]) filter).
 *  2. The response attaches payment_status_derived / refunded_amount per order, computed
 *     via the same lib/payments/get-payment-projection.ts helper app/api/terminal/tables
 *     already uses -- and that those fields move paid -> partially_refunded -> refunded
 *     correctly as real payment_events rows are inserted, exactly like the tables route.
 *
 *   npx tsx scripts/verify-terminal-orders-completed-refund-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const APP = process.env.VERIFY_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing — set in .env.local')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `orders-completed-${Date.now()}`
let orderId: string | null = null

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

async function getActiveTerminal(): Promise<{ id: string; device_serial: string }> {
  const { data, error } = await admin
    .from('restaurant_terminals')
    .select('id, device_serial, status, active')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('active', true)
    .eq('status', 'active')
    .not('device_serial', 'is', null)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id || !data.device_serial) {
    throw new Error('No active terminal with device_serial found')
  }
  return { id: String(data.id), device_serial: String(data.device_serial) }
}

async function getOrders(
  jwt: string,
): Promise<{ status: number; json: { orders?: Array<Record<string, unknown>> } }> {
  const res = await fetch(`${APP}/api/terminal/orders`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const json = (await res.json().catch(() => ({}))) as { orders?: Array<Record<string, unknown>> }
  return { status: res.status, json }
}

async function main() {
  const terminal = await getActiveTerminal()
  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  // Real completed, individually-paid (Sale) standalone order -- table_number 0, channel 'pos'.
  const orderNumber = Math.floor(Date.now() / 1000) % 1000000
  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      table_number: 0,
      order_number: orderNumber,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      payment_channel: 'card_manual',
      channel: 'pos',
      subtotal: 42.5,
      total: 42.5,
      items: [{ name: `Test Item ${tag}`, quantity: 1, subtotal: 42.5 }],
      is_closed: true,
    })
    .select('id')
    .single()
  if (orderError || !order?.id) throw orderError || new Error('order insert failed')
  orderId = String(order.id)

  // 1. Endpoint now returns the completed order at all (previously filtered out entirely).
  const before = await getOrders(jwt)
  const foundBefore = (before.json.orders ?? []).find((o) => o.id === orderId)
  record(
    '1-completed-order-returned',
    before.status === 200 && !!foundBefore && foundBefore.status === 'completed',
    `status=${before.status} found=${!!foundBefore} orderStatus=${foundBefore?.status}`,
  )
  record(
    '1-payment-fields-present-no-sale-yet',
    foundBefore?.payment_status_derived === null && foundBefore?.refunded_amount === 0,
    `payment_status_derived=${foundBefore?.payment_status_derived} refunded_amount=${foundBefore?.refunded_amount} (no payment_events sale row yet, so both should be null/0)`,
  )

  // 2. Record a real SALE payment_event -> paid.
  const businessOrderNo = `${tag}-biz`
  const { error: saleError } = await admin.from('payment_events').insert({
    restaurant_id: RESTAURANT_ID,
    event_type: 'sale',
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    order_ids: [orderId],
    amount: 42.5,
    currency: 'NAD',
    idempotency_key: `sale-${tag}`,
    reason_code: 'n/a',
  })
  if (saleError) throw saleError

  const afterSale = await getOrders(jwt)
  const foundAfterSale = (afterSale.json.orders ?? []).find((o) => o.id === orderId)
  record(
    '2-paid-after-sale',
    foundAfterSale?.payment_status_derived === 'paid' && foundAfterSale?.refunded_amount === 0,
    `payment_status_derived=${foundAfterSale?.payment_status_derived} refunded_amount=${foundAfterSale?.refunded_amount}`,
  )

  // 3. Partial refund -> partially_refunded, refunded_amount reflects it.
  const { error: partialRefundError } = await admin.from('payment_events').insert({
    restaurant_id: RESTAURANT_ID,
    event_type: 'refund_succeeded',
    business_order_no: `${businessOrderNo}-R1`,
    origin_business_order_no: businessOrderNo,
    order_ids: [orderId],
    amount: 15,
    currency: 'NAD',
    idempotency_key: `refund-partial-${tag}`,
    reason_code: 'customer_request',
  })
  if (partialRefundError) throw partialRefundError

  const afterPartial = await getOrders(jwt)
  const foundAfterPartial = (afterPartial.json.orders ?? []).find((o) => o.id === orderId)
  record(
    '3-partially-refunded',
    foundAfterPartial?.payment_status_derived === 'partially_refunded' &&
      foundAfterPartial?.refunded_amount === 15,
    `payment_status_derived=${foundAfterPartial?.payment_status_derived} refunded_amount=${foundAfterPartial?.refunded_amount}`,
  )

  // 4. Full refund (remaining 27.5) -> refunded, refunded_amount = 42.5.
  const { error: fullRefundError } = await admin.from('payment_events').insert({
    restaurant_id: RESTAURANT_ID,
    event_type: 'refund_succeeded',
    business_order_no: `${businessOrderNo}-R2`,
    origin_business_order_no: businessOrderNo,
    order_ids: [orderId],
    amount: 27.5,
    currency: 'NAD',
    idempotency_key: `refund-full-${tag}`,
    reason_code: 'customer_request',
  })
  if (fullRefundError) throw fullRefundError

  const afterFull = await getOrders(jwt)
  const foundAfterFull = (afterFull.json.orders ?? []).find((o) => o.id === orderId)
  record(
    '4-fully-refunded',
    foundAfterFull?.payment_status_derived === 'refunded' && foundAfterFull?.refunded_amount === 42.5,
    `payment_status_derived=${foundAfterFull?.payment_status_derived} refunded_amount=${foundAfterFull?.refunded_amount}`,
  )

  console.log('TERMINAL_ORDERS_COMPLETED_REFUND_STAGING_OK')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (orderId) {
      await admin.from('payment_events').delete().eq('restaurant_id', RESTAURANT_ID).ilike('idempotency_key', `%${tag}%`)
      await admin.from('orders').delete().eq('id', orderId)
      console.log(`cleanup: deleted order id=${orderId} and its payment_events`)
    }
  })
