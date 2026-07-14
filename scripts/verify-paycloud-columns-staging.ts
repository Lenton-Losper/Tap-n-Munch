/**
 * Staging verification for #24: orders.paycloud_transaction_id and
 * orders.payment_trans_no were referenced by app code (webhook patch
 * builders in lib/supabase/apply-tab-settlement.ts, and
 * app/api/payments/reconcile/route.ts) but missing from any committed
 * migration. Confirms (1) they didn't exist before this fix, is proven by
 * the issue investigation itself (information_schema query before applying
 * migration 20260714130000), and (2) the real patch-building functions now
 * write successfully against a real orders row.
 *
 *   npx tsx scripts/verify-paycloud-columns-staging.ts
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}
// lib/supabase/apply-tab-settlement.ts transitively imports the browser
// client module, which reads these at import time.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY

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

let nextOrderNumber = Math.floor(Date.now() / 1000) % 1_000_000

async function main() {
  const { buildWebhookPaidPatch, buildWebhookTerminalPaidPatch } = await import(
    '@/lib/supabase/apply-tab-settlement'
  )
  const tag = randomUUID().slice(0, 8)
  let restaurantId: string | null = null
  const orderIds: string[] = []

  console.log(`[${ts()}] === orders.paycloud_transaction_id / payment_trans_no staging verification (#24) ===`)

  try {
    const { data: restaurant, error: restErr } = await admin
      .from('restaurants')
      .insert({ name: `Paycloud Columns Test ${tag}`, currency: 'NAD' })
      .select('id')
      .single()
    if (restErr || !restaurant?.id) throw restErr || new Error('restaurant insert failed')
    restaurantId = String(restaurant.id)

    // --- buildWebhookPaidPatch: dine-in tab webhook path ---
    const order1Id = randomUUID()
    const { error: order1Error } = await admin.from('orders').insert({
      id: order1Id,
      restaurant_id: restaurantId,
      order_number: nextOrderNumber++,
      total: 100,
      status: 'pending',
      payment_status: 'pending',
      placed_at: new Date().toISOString(),
      items: [],
    })
    if (order1Error) throw order1Error
    orderIds.push(order1Id)

    const transNo1 = `PC-TRANS-${tag}-1`
    const patch1 = buildWebhookPaidPatch('pending', transNo1)
    const { error: update1Error } = await admin.from('orders').update(patch1).eq('id', order1Id)
    await assert(!update1Error, `buildWebhookPaidPatch UPDATE succeeds against real orders row (error: ${update1Error?.message ?? 'none'})`)

    const { data: order1After, error: order1AfterError } = await admin
      .from('orders')
      .select('payment_trans_no, paycloud_transaction_id, payment_status, status')
      .eq('id', order1Id)
      .single()
    if (order1AfterError) throw order1AfterError
    await assert(order1After.payment_trans_no === transNo1, 'payment_trans_no persisted correctly')
    await assert(order1After.paycloud_transaction_id === transNo1, 'paycloud_transaction_id persisted correctly')
    await assert(order1After.payment_status === 'paid', 'payment_status updated to paid')
    await assert(order1After.status === 'accepted', 'status updated to accepted (was pending)')

    // --- buildWebhookTerminalPaidPatch: terminal webhook path ---
    const order2Id = randomUUID()
    const { error: order2Error } = await admin.from('orders').insert({
      id: order2Id,
      restaurant_id: restaurantId,
      order_number: nextOrderNumber++,
      total: 50,
      status: 'pending',
      payment_status: 'pending',
      placed_at: new Date().toISOString(),
      items: [],
    })
    if (order2Error) throw order2Error
    orderIds.push(order2Id)

    const transNo2 = `PC-TRANS-${tag}-2`
    const patch2 = buildWebhookTerminalPaidPatch(transNo2)
    const { error: update2Error } = await admin.from('orders').update(patch2).eq('id', order2Id)
    await assert(!update2Error, `buildWebhookTerminalPaidPatch UPDATE succeeds against real orders row (error: ${update2Error?.message ?? 'none'})`)

    const { data: order2After, error: order2AfterError } = await admin
      .from('orders')
      .select('payment_trans_no, paycloud_transaction_id, payment_status, status')
      .eq('id', order2Id)
      .single()
    if (order2AfterError) throw order2AfterError
    await assert(order2After.payment_trans_no === transNo2, 'terminal path: payment_trans_no persisted correctly')
    await assert(order2After.paycloud_transaction_id === transNo2, 'terminal path: paycloud_transaction_id persisted correctly')
    await assert(order2After.status === 'completed', 'terminal path: status updated to completed')

    // --- app/api/payments/reconcile/route.ts patch shape: paycloud_transaction_id only ---
    const order3Id = randomUUID()
    const { error: order3Error } = await admin.from('orders').insert({
      id: order3Id,
      restaurant_id: restaurantId,
      order_number: nextOrderNumber++,
      total: 25,
      status: 'pending',
      payment_status: 'pending',
      placed_at: new Date().toISOString(),
      items: [],
    })
    if (order3Error) throw order3Error
    orderIds.push(order3Id)

    const reconcilePatch = { status: 'accepted', payment_status: 'paid', paycloud_transaction_id: `RECON-${tag}` }
    const { error: reconcileError } = await admin.from('orders').update(reconcilePatch).eq('id', order3Id)
    await assert(!reconcileError, `reconcile-route-shaped UPDATE succeeds against real orders row (error: ${reconcileError?.message ?? 'none'})`)

    console.log(`\n[${ts()}] orders.paycloud_transaction_id / payment_trans_no verification passed.`)
  } finally {
    if (restaurantId) {
      await admin.from('orders').delete().eq('restaurant_id', restaurantId)
      await admin.from('restaurants').delete().eq('id', restaurantId)
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
