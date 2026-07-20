/**
 * Staging verification: receipt print-layout visual elements (lib/receipts/renderers/htmlRenderer.ts
 * renderPrintLayout) against real order data across two channels.
 *   npx tsx scripts/verify-receipt-print-layout-cafe-schneider-staging.ts
 *
 * Covers:
 *   1. A kiosk order with a customer name -> issued receipt -> print layout shows the
 *      document number, issued_at, and "Name: <value>" line.
 *   2. A POS order (customer_name always null on this channel) -> issued receipt -> print
 *      layout omits the Name line entirely -- never a blank "Name:".
 *   3. Both renders include the asterisk header box, "-YOUR RECEIPT-" label, ITEM
 *      DESCRIPTION/QTY/PRICE column headers, "Items: N" line, and a left-aligned Thank you.
 *   4. Neither render includes a VAT-rate breakdown line (e.g. "VAT @ 15%") -- still excluded,
 *      same unresolved calculation gap as before.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { issueReceiptForOrder } from '../lib/receipts/issueReceipt'
import { renderReceiptHtml } from '../lib/receipts/renderers/htmlRenderer'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `receipt-print-${Date.now()}`

const created = {
  orderIds: [] as string[],
  menuItemIds: [] as string[],
  receiptDocumentIds: [] as string[],
}

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
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function makeOrder(opts: {
  channel: 'kiosk' | 'pos'
  tableNumber: number
  customerName: string | null
  itemName: string
  quantity: number
  unitPrice: number
}) {
  const { data: menuItem, error: menuItemError } = await db
    .from('menu_items')
    .insert({ restaurant_id: TEST_RESTAURANT_ID, name: opts.itemName, base_price: opts.unitPrice })
    .select('id, name')
    .single()
  if (menuItemError || !menuItem) throw menuItemError ?? new Error('menu item insert failed')
  created.menuItemIds.push(menuItem.id)

  const subtotal = opts.unitPrice * opts.quantity
  const tax = Math.round(subtotal * 0.15 * 100) / 100
  const total = subtotal + tax

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: opts.tableNumber,
      status: 'completed',
      payment_status: 'paid',
      payment_method: opts.channel === 'kiosk' ? 'card' : 'cash',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal,
      tax,
      total,
      items: [
        {
          menu_item_id: menuItem.id,
          name: opts.itemName,
          quantity: opts.quantity,
          basePrice: opts.unitPrice,
          subtotal,
        },
      ],
      channel: opts.channel,
      customer_name: opts.customerName,
    })
    .select('id')
    .single()
  if (orderError || !order) throw orderError ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  const businessOrderNo = `BON-${tag}-${opts.channel}`
  const { error: saleEventError } = await db.from('payment_events').insert({
    restaurant_id: TEST_RESTAURANT_ID,
    order_ids: [order.id],
    event_type: 'sale',
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    transaction_id: `TXN-${tag}-${opts.channel}`,
    terminal_id: 'TERM-TEST',
    amount: total,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleEventError) throw saleEventError

  return order.id
}

function assertCommonPrintElements(print: string, label: string) {
  assert(print.includes('-YOUR RECEIPT-'), `${label}: missing -YOUR RECEIPT- label`)
  assert(print.includes('ITEM DESCRIPTION'), `${label}: missing ITEM DESCRIPTION header`)
  assert(print.includes('>QTY<'), `${label}: missing QTY header`)
  assert(print.includes('>PRICE<'), `${label}: missing PRICE header`)
  assert((print.match(/\*/g) || []).length > 10, `${label}: missing asterisk header box`)
  assert(/Items: \d+/.test(print), `${label}: missing Items: N line`)
  assert(/text-align:\s*left;[^"]*">Thank you/.test(print), `${label}: Thank you should be left-aligned`)
  assert(!/VAT\s*@\s*\d/.test(print), `${label}: must not show a VAT-rate breakdown line`)
}

function printOnlySection(html: string): string {
  const start = html.indexOf('class="print-only"')
  assert(start > -1, 'no print-only section found')
  return html.slice(start)
}

async function main() {
  // --- Channel 1: kiosk, with a customer name ---
  const kioskOrderId = await makeOrder({
    channel: 'kiosk',
    tableNumber: 12,
    customerName: 'Jane Kiosk',
    itemName: `${tag} Kiosk Burger`,
    quantity: 2,
    unitPrice: 45,
  })
  const kioskReceipt = await issueReceiptForOrder(kioskOrderId)
  created.receiptDocumentIds.push(kioskReceipt.id)
  assert(kioskReceipt.snapshot_json.customer_name === 'Jane Kiosk', 'kiosk snapshot should carry the customer name')

  const kioskHtml = renderReceiptHtml(kioskReceipt.snapshot_json, {
    documentNumber: kioskReceipt.document_number,
    issuedAt: kioskReceipt.issued_at,
  })
  const kioskPrint = printOnlySection(kioskHtml)
  assert(kioskPrint.includes(kioskReceipt.document_number), 'kiosk print layout missing document number')
  assert(kioskPrint.includes('Name: Jane Kiosk'), 'kiosk print layout missing Name: line')
  assertCommonPrintElements(kioskPrint, 'kiosk')

  // --- Channel 2: POS, customer_name always null on this channel ---
  const posOrderId = await makeOrder({
    channel: 'pos',
    tableNumber: 0,
    customerName: null,
    itemName: `${tag} POS Steak`,
    quantity: 1,
    unitPrice: 120,
  })
  const posReceipt = await issueReceiptForOrder(posOrderId)
  created.receiptDocumentIds.push(posReceipt.id)
  assert(posReceipt.snapshot_json.customer_name === null, 'POS snapshot should have a null customer name')

  const posHtml = renderReceiptHtml(posReceipt.snapshot_json, {
    documentNumber: posReceipt.document_number,
    issuedAt: posReceipt.issued_at,
  })
  const posPrint = printOnlySection(posHtml)
  assert(posPrint.includes(posReceipt.document_number), 'POS print layout missing document number')
  assert(!posPrint.includes('Name:'), 'POS print layout must never show a Name: line when customer_name is null')
  assertCommonPrintElements(posPrint, 'pos')

  console.log('RECEIPT_PRINT_LAYOUT_STAGING_VERIFY_OK', {
    kioskOrderId,
    kioskReceiptId: kioskReceipt.id,
    kioskDocumentNumber: kioskReceipt.document_number,
    posOrderId,
    posReceiptId: posReceipt.id,
    posDocumentNumber: posReceipt.document_number,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('RECEIPT_PRINT_LAYOUT_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
