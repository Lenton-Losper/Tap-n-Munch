/**
 * ONE-OFF, DESTRUCTIVE, PRODUCTION: hard-delete every order at Riviera placed before
 * 2026-08-29 (Namibia local midnight, UTC+2 -> 2026-08-28T22:00:00.000Z UTC), and everything that
 * hangs off those orders. Explicitly requested and confirmed 2026-08-29: "everything before
 * today, no exceptions" / "hard delete".
 *
 * ============================================================================================
 * WHAT CASCADES AUTOMATICALLY, AND WHAT DOES NOT (read off the actual FK definitions, not assumed)
 * ============================================================================================
 *
 * ON DELETE CASCADE from orders(id): order_lines, order_line_allocations,
 * order_line_allocation_settlements (via order_line_allocations), order_line_events (via
 * order_lines), refund_events, invoice_requests, order_revisions. Deleting `orders` rows takes
 * all of these with it -- nothing to do manually.
 *
 * NO CASCADE (defaults to RESTRICT) from orders(id): payment_events, receipt_documents. These
 * MUST be deleted first or the orders delete fails with a foreign key violation.
 *
 * order_requests.accepted_order_id references orders(id) with NO CASCADE, and
 * `CHECK (status <> 'accepted' OR accepted_order_id IS NOT NULL)` means it cannot simply be
 * nulled out for an 'accepted' row. Deleted outright instead, scoped by the SAME
 * restaurant+placed_at cutoff -- consistent with "wipe all history before today", not a
 * workaround for the constraint.
 *
 * CIRCULAR: orders.source_request_id ALSO references order_requests(id) (nullable, no cascade,
 * 20260816090000_orders_source_request_id.sql) -- found only by running this against production
 * and reading the real FK violation, not from the migration sweep above. order_requests cannot be
 * deleted while an order still points at it via source_request_id, so that column is nulled out
 * on the doomed orders FIRST, before order_requests is deleted.
 *
 * Usage:
 *   npx tsx scripts/wipe-riviera-pre-launch-orders-production.ts              (preview, no writes)
 *   npx tsx scripts/wipe-riviera-pre-launch-orders-production.ts --execute    (actually deletes)
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.local'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL points at STAGING (${STAGING_REF}).`)
if (!URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL is not the production ref (${PRODUCTION_REF}). Got: ${URL || '(empty)'}`)
if (!SERVICE_KEY) throw new Error('REFUSING: no service role key in .env.local')

const db = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const CUTOFF_ISO = '2026-08-28T22:00:00.000Z' // 2026-08-29T00:00:00 in Namibia (UTC+2)

const execute = process.argv.includes('--execute')

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main() {
  console.log(`Target: Riviera (${RIVIERA_ID}), cutoff placed_at < ${CUTOFF_ISO}`)
  console.log(`Mode: ${execute ? 'EXECUTE (will delete)' : 'PREVIEW ONLY (no writes)'}\n`)

  const { data: doomedOrders, error: ordersReadError } = await db
    .from('orders')
    .select('id')
    .eq('restaurant_id', RIVIERA_ID)
    .lt('placed_at', CUTOFF_ISO)

  if (ordersReadError) throw ordersReadError
  const orderIds = (doomedOrders ?? []).map((r) => String(r.id))
  console.log(`orders matching:            ${orderIds.length}`)

  if (orderIds.length === 0) {
    console.log('\nNothing to do.')
    return
  }

  let paymentEventsCount = 0
  let receiptDocumentsCount = 0
  for (const ids of chunk(orderIds, 300)) {
    // payment_events.order_id was dropped and replaced with order_ids uuid[] --
    // 20260705340000_payment_events_order_ids_array.sql. No FK constraint on an array column,
    // so this table never actually blocks deleting orders; queried for completeness/hygiene only.
    const { count: pe } = await db
      .from('payment_events')
      .select('id', { count: 'exact', head: true })
      .overlaps('order_ids', ids)
    paymentEventsCount += pe ?? 0

    const { count: rd } = await db
      .from('receipt_documents')
      .select('id', { count: 'exact', head: true })
      .in('order_id', ids)
    receiptDocumentsCount += rd ?? 0
  }
  console.log(`payment_events referencing: ${paymentEventsCount}`)
  console.log(`receipt_documents referencing: ${receiptDocumentsCount}`)

  const { count: orderRequestsCount } = await db
    .from('order_requests')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', RIVIERA_ID)
    .lt('placed_at', CUTOFF_ISO)
  console.log(`order_requests matching (same cutoff): ${orderRequestsCount ?? 0}`)

  console.log(
    '\n(order_lines, order_line_events, order_line_allocations, order_line_allocation_settlements,',
  )
  console.log(' refund_events, invoice_requests, order_revisions all cascade automatically with the orders delete.)')

  if (!execute) {
    console.log('\nPreview only. Re-run with --execute to actually delete.')
    return
  }

  console.log('\n--- EXECUTING ---')

  let sourceRequestNulled = 0
  for (const ids of chunk(orderIds, 300)) {
    const { error: nullError, count: nullCount } = await db
      .from('orders')
      .update({ source_request_id: null }, { count: 'exact' })
      .in('id', ids)
      .not('source_request_id', 'is', null)
    if (nullError) throw nullError
    sourceRequestNulled += nullCount ?? 0
  }
  console.log(`Cleared orders.source_request_id (circular FK back to order_requests): ${sourceRequestNulled}`)

  const { error: orderRequestsDeleteError, count: orDeleted } = await db
    .from('order_requests')
    .delete({ count: 'exact' })
    .eq('restaurant_id', RIVIERA_ID)
    .lt('placed_at', CUTOFF_ISO)
  if (orderRequestsDeleteError) throw orderRequestsDeleteError
  console.log(`Deleted order_requests: ${orDeleted ?? 0}`)

  let peDeleted = 0
  let rdDeliveriesDeleted = 0
  let rdDeleted = 0
  for (const ids of chunk(orderIds, 300)) {
    const { error: peError, count: peCount } = await db
      .from('payment_events')
      .delete({ count: 'exact' })
      .overlaps('order_ids', ids)
    if (peError) throw peError
    peDeleted += peCount ?? 0

    // receipt_deliveries.receipt_document_id -> receipt_documents(id), NOT NULL, no cascade
    // (20260717160000_receipt_deliveries_and_terminal_printer_configs.sql) -- found the same way
    // as the source_request_id circularity, by running this and reading the real FK violation.
    // Deleted first, scoped to exactly the doomed receipt_documents' own ids.
    const { data: doomedReceipts, error: receiptsReadError } = await db
      .from('receipt_documents')
      .select('id')
      .in('order_id', ids)
    if (receiptsReadError) throw receiptsReadError
    const receiptIds = (doomedReceipts ?? []).map((r) => String(r.id))

    if (receiptIds.length > 0) {
      const { error: rdelError, count: rdelCount } = await db
        .from('receipt_deliveries')
        .delete({ count: 'exact' })
        .in('receipt_document_id', receiptIds)
      if (rdelError) throw rdelError
      rdDeliveriesDeleted += rdelCount ?? 0
    }

    const { error: rdError, count: rdCount } = await db
      .from('receipt_documents')
      .delete({ count: 'exact' })
      .in('order_id', ids)
    if (rdError) throw rdError
    rdDeleted += rdCount ?? 0
  }
  console.log(`Deleted payment_events: ${peDeleted}`)
  console.log(`Deleted receipt_deliveries: ${rdDeliveriesDeleted}`)
  console.log(`Deleted receipt_documents: ${rdDeleted}`)

  let ordersDeleted = 0
  for (const ids of chunk(orderIds, 300)) {
    const { error: delError, count: delCount } = await db
      .from('orders')
      .delete({ count: 'exact' })
      .in('id', ids)
    if (delError) throw delError
    ordersDeleted += delCount ?? 0
  }
  console.log(`Deleted orders (cascaded lines/events/allocations/refunds/invoices/revisions): ${ordersDeleted}`)

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('WIPE SCRIPT FAILED:', err)
  process.exitCode = 1
})
