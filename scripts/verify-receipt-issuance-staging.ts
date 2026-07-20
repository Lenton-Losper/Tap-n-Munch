/**
 * Staging verification: receipt issuance (lib/receipts/issueReceipt.ts) against real data.
 *   npx tsx scripts/verify-receipt-issuance-staging.ts
 *
 * Covers:
 *   1. Real paid order + sale payment_events row -> exactly one receipt_documents row,
 *      snapshot_json correctly populated.
 *   2. Re-calling issueReceiptForOrder for the same order returns the existing row (no 2nd insert).
 *   3. Renaming the menu item + changing the restaurant's address after issuance does not
 *      change the already-issued receipt's snapshot_json (point-in-time capture, not a live join).
 *   4. Concurrent/duplicate calls to issueReceiptForOrder (simulating the payment-completion
 *      path firing twice in quick succession) still produce exactly one row.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { issueReceiptForOrder } from '../lib/receipts/issueReceipt'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

// lib/receipts/issueReceipt.ts reads these directly via createServerSupabaseClient()
// at call time (not at import time), so setting them here before main() runs is enough.
process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `receipt-${Date.now()}`

const created = {
  orderIds: [] as string[],
  menuItemIds: [] as string[],
  receiptDocumentIds: [] as string[],
}

let originalRestaurantAddress: string | null | undefined

async function cleanup() {
  if (created.receiptDocumentIds.length) {
    await db.from('receipt_documents').delete().in('id', created.receiptDocumentIds)
  }
  if (created.orderIds.length) {
    await db.from('payment_events').delete().overlaps('order_ids', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
  if (created.menuItemIds.length) {
    await db.from('menu_items').delete().in('id', created.menuItemIds)
  }
  if (originalRestaurantAddress !== undefined) {
    await db.from('restaurants').update({ address: originalRestaurantAddress }).eq('id', TEST_RESTAURANT_ID)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .select('id, name, address, currency')
    .eq('id', TEST_RESTAURANT_ID)
    .single()
  if (restaurantError || !restaurant) throw restaurantError ?? new Error('restaurant fixture not found')
  originalRestaurantAddress = restaurant.address

  const originalMenuItemName = `${tag} Original Burger`
  const { data: menuItem, error: menuItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      name: originalMenuItemName,
      base_price: 50,
    })
    .select('id, name')
    .single()
  if (menuItemError || !menuItem) throw menuItemError ?? new Error('menu item insert failed')
  created.menuItemIds.push(menuItem.id)

  const subtotal = 100
  const tax = 15
  const total = subtotal + tax

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 77,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal,
      tax,
      total,
      items: [
        {
          menu_item_id: menuItem.id,
          name: originalMenuItemName,
          quantity: 2,
          price: 50,
        },
      ],
      channel: 'pos',
    })
    .select('id')
    .single()
  if (orderError || !order) throw orderError ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  const transactionId = `TXN${tag}9999`
  const businessOrderNo = `BON-${tag}`

  const { error: saleEventError } = await db.from('payment_events').insert({
    restaurant_id: TEST_RESTAURANT_ID,
    order_ids: [order.id],
    event_type: 'sale',
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    transaction_id: transactionId,
    terminal_id: 'TERM-TEST',
    amount: total,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleEventError) throw saleEventError

  // --- 1. Issue the receipt, confirm exactly one row with a correctly populated snapshot ---
  const first = await issueReceiptForOrder(order.id)
  created.receiptDocumentIds.push(first.id)

  const { data: rowsAfterFirst, error: rowsAfterFirstError } = await db
    .from('receipt_documents')
    .select('*')
    .eq('order_id', order.id)
  if (rowsAfterFirstError) throw rowsAfterFirstError
  assert(rowsAfterFirst?.length === 1, `expected exactly 1 row after first issuance, got ${rowsAfterFirst?.length}`)

  const snapshot = first.snapshot_json
  assert(snapshot.outlet.restaurant_name === restaurant.name, 'snapshot outlet.restaurant_name mismatch')
  assert(snapshot.outlet.address === restaurant.address, 'snapshot outlet.address mismatch')
  assert(snapshot.line_items.length === 1, 'snapshot should have 1 line item')
  assert(snapshot.line_items[0].name === originalMenuItemName, 'snapshot line item name mismatch')
  assert(snapshot.line_items[0].quantity === 2, 'snapshot line item quantity mismatch')
  assert(snapshot.line_items[0].unit_price === 50, 'snapshot line item unit_price mismatch')
  assert(snapshot.line_items[0].line_total === 100, 'snapshot line item line_total mismatch')
  assert(snapshot.totals.subtotal === subtotal, 'snapshot totals.subtotal mismatch')
  assert(snapshot.totals.vat === tax, 'snapshot totals.vat mismatch')
  assert(snapshot.totals.discount === 0, 'snapshot totals.discount mismatch')
  assert(snapshot.totals.grand_total === total, 'snapshot totals.grand_total mismatch')
  assert(snapshot.payments.length === 1, 'snapshot should have 1 payment')
  assert(snapshot.payments[0].method === 'card', 'snapshot payment method mismatch')
  assert(snapshot.payments[0].amount === total, 'snapshot payment amount mismatch')
  assert(
    snapshot.payments[0].masked_reference === `${'*'.repeat(transactionId.length - 4)}${transactionId.slice(-4)}`,
    `snapshot payment masked_reference wrong: ${snapshot.payments[0].masked_reference}`,
  )
  assert(
    !JSON.stringify(snapshot).includes(transactionId),
    'snapshot must not contain the raw unmasked transaction_id',
  )
  assert(first.document_number.startsWith('RCT-'), `document_number should have RCT- prefix, got ${first.document_number}`)

  // --- 2. Re-calling issueReceiptForOrder returns the existing row, no 2nd insert ---
  const second = await issueReceiptForOrder(order.id)
  assert(second.id === first.id, 'second call should return the same receipt id')
  assert(second.document_number === first.document_number, 'second call should return the same document_number')

  const { data: rowsAfterSecond, error: rowsAfterSecondError } = await db
    .from('receipt_documents')
    .select('id')
    .eq('order_id', order.id)
  if (rowsAfterSecondError) throw rowsAfterSecondError
  assert(rowsAfterSecond?.length === 1, `expected still exactly 1 row after re-call, got ${rowsAfterSecond?.length}`)

  // --- 3. Renaming the menu item + changing the restaurant address after issuance must not
  //        change the already-issued receipt's snapshot ---
  const renamedMenuItemName = `${tag} Renamed Burger`
  const changedAddress = `${tag} 123 Changed Street`

  const { error: renameError } = await db
    .from('menu_items')
    .update({ name: renamedMenuItemName })
    .eq('id', menuItem.id)
  if (renameError) throw renameError

  const { error: addressError } = await db
    .from('restaurants')
    .update({ address: changedAddress })
    .eq('id', TEST_RESTAURANT_ID)
  if (addressError) throw addressError

  const { data: refetched, error: refetchedError } = await db
    .from('receipt_documents')
    .select('snapshot_json')
    .eq('id', first.id)
    .single()
  if (refetchedError || !refetched) throw refetchedError ?? new Error('refetch failed')

  const refetchedSnapshot = refetched.snapshot_json
  assert(
    refetchedSnapshot.outlet.restaurant_name === restaurant.name,
    'snapshot restaurant_name should remain the pre-rename value',
  )
  assert(
    refetchedSnapshot.outlet.address === restaurant.address,
    `snapshot address should remain the original value, got ${refetchedSnapshot.outlet.address}`,
  )
  assert(
    refetchedSnapshot.outlet.address !== changedAddress,
    'snapshot address must not reflect the post-issuance change',
  )
  assert(
    refetchedSnapshot.line_items[0].name === originalMenuItemName,
    `snapshot line item name should remain the pre-rename value, got ${refetchedSnapshot.line_items[0].name}`,
  )
  assert(
    refetchedSnapshot.line_items[0].name !== renamedMenuItemName,
    'snapshot line item name must not reflect the post-issuance rename',
  )
  assert(
    JSON.stringify(refetchedSnapshot) === JSON.stringify(snapshot),
    'refetched snapshot_json should be byte-identical to the originally issued snapshot',
  )

  // --- 4. Concurrent/duplicate issuance calls (simulating the payment-completion path
  //        firing twice in quick succession) still produce exactly one row ---
  const concurrentOrderTag = `${tag}-concurrent`
  const { data: concurrentMenuItem, error: concurrentMenuItemError } = await db
    .from('menu_items')
    .insert({ restaurant_id: TEST_RESTAURANT_ID, name: `${concurrentOrderTag} Item`, base_price: 25 })
    .select('id, name')
    .single()
  if (concurrentMenuItemError || !concurrentMenuItem) throw concurrentMenuItemError ?? new Error('menu item insert failed')
  created.menuItemIds.push(concurrentMenuItem.id)

  const { data: concurrentOrder, error: concurrentOrderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 78,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'cash',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 25,
      tax: 0,
      total: 25,
      items: [{ menu_item_id: concurrentMenuItem.id, name: concurrentMenuItem.name, quantity: 1, price: 25 }],
      channel: 'pos',
    })
    .select('id')
    .single()
  if (concurrentOrderError || !concurrentOrder) throw concurrentOrderError ?? new Error('order insert failed')
  created.orderIds.push(concurrentOrder.id)

  const concurrentBusinessOrderNo = `BON-${concurrentOrderTag}`
  const { error: concurrentSaleEventError } = await db.from('payment_events').insert({
    restaurant_id: TEST_RESTAURANT_ID,
    order_ids: [concurrentOrder.id],
    event_type: 'sale',
    business_order_no: concurrentBusinessOrderNo,
    origin_business_order_no: concurrentBusinessOrderNo,
    transaction_id: `TXN${concurrentOrderTag}`,
    terminal_id: 'TERM-TEST',
    amount: 25,
    currency: 'NAD',
    idempotency_key: concurrentBusinessOrderNo,
    reason_code: 'sale',
  })
  if (concurrentSaleEventError) throw concurrentSaleEventError

  const [concurrentA, concurrentB] = await Promise.all([
    issueReceiptForOrder(concurrentOrder.id),
    issueReceiptForOrder(concurrentOrder.id),
  ])
  created.receiptDocumentIds.push(concurrentA.id)
  assert(concurrentA.id === concurrentB.id, 'concurrent calls should resolve to the same receipt id')

  const { data: concurrentRows, error: concurrentRowsError } = await db
    .from('receipt_documents')
    .select('id')
    .eq('order_id', concurrentOrder.id)
  if (concurrentRowsError) throw concurrentRowsError
  assert(
    concurrentRows?.length === 1,
    `expected exactly 1 row after concurrent issuance, got ${concurrentRows?.length}`,
  )

  console.log('RECEIPT_ISSUANCE_STAGING_VERIFY_OK', {
    orderId: order.id,
    receiptId: first.id,
    documentNumber: first.document_number,
    concurrentOrderId: concurrentOrder.id,
    concurrentReceiptId: concurrentA.id,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('RECEIPT_ISSUANCE_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
