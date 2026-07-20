/**
 * Staging verification: the three new terminal-authenticated print-flow routes
 * (GET /api/terminal/receipts/[orderId], POST /api/terminal/receipt-deliveries,
 * GET+POST /api/terminal/printer-config), invoked directly as route handlers against
 * real staging data and a real signed terminal JWT (jose), same as
 * scripts/verify-terminal-orders-completed-refund-staging.ts.
 *   npx tsx scripts/verify-terminal-receipt-print-routes-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })
config({ path: '.env.local', override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing -- set in .env.local')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `printroutes-${Date.now()}`

const created = {
  orderIds: [] as string[],
  terminalIds: [] as string[],
}

async function cleanup() {
  if (created.terminalIds.length) {
    await db.from('terminal_printer_configs').delete().in('terminal_id', created.terminalIds)
    await db.from('restaurant_terminals').delete().in('id', created.terminalIds)
  }
  if (created.orderIds.length) {
    const { data: receiptRows } = await db
      .from('receipt_documents')
      .select('id')
      .in('order_id', created.orderIds)
    const receiptIds = (receiptRows ?? []).map((r) => r.id)
    if (receiptIds.length) {
      await db.from('receipt_deliveries').delete().in('receipt_document_id', receiptIds)
    }
    await db.from('receipt_documents').delete().in('order_id', created.orderIds)
    await db.from('payment_events').delete().overlaps('order_ids', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const { data: terminal, error: terminalError } = await db
    .from('restaurant_terminals')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      device_id: `DEVICE-${tag}`,
      device_serial: `SERIAL-${tag}`,
      name: `${tag} terminal`,
      status: 'active',
    })
    .select('id, device_serial')
    .single()
  if (terminalError || !terminal) throw terminalError ?? new Error('terminal insert failed')
  created.terminalIds.push(terminal.id)

  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: TEST_RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  // --- seed a real paid order + sale event + issued receipt ---
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 81,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 60,
      tax: 9,
      total: 69,
      items: [{ name: `${tag} item`, quantity: 1, price: 60 }],
      channel: 'pos',
    })
    .select('id')
    .single()
  if (orderError || !order) throw orderError ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  const businessOrderNo = `BON-${tag}`
  const { error: saleError } = await db.from('payment_events').insert({
    restaurant_id: TEST_RESTAURANT_ID,
    order_ids: [order.id],
    event_type: 'sale',
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    transaction_id: `TXN${tag}`,
    terminal_id: terminal.id,
    amount: 69,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleError) throw saleError

  const { issueReceiptForOrder } = await import('../lib/receipts/issueReceipt')
  const receipt = await issueReceiptForOrder(order.id)

  // --- GET /api/terminal/receipts/[orderId] ---
  const { GET: getReceiptRoute } = await import('../app/api/terminal/receipts/[orderId]/route')
  const receiptReq = new Request(`https://staging.test/api/terminal/receipts/${order.id}?characterWidth=32`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const receiptRes = await getReceiptRoute(receiptReq, { params: Promise.resolve({ orderId: order.id }) })
  assert(receiptRes.status === 200, `GET receipts should return 200, got ${receiptRes.status}`)
  const receiptBody = (await receiptRes.json()) as {
    id: string
    documentNumber: string
    escposBase64: string
  }
  assert(receiptBody.id === receipt.id, 'GET receipts should return the issued receipt id')
  assert(receiptBody.documentNumber === receipt.document_number, 'documentNumber should match')
  const escposBytes = Buffer.from(receiptBody.escposBase64, 'base64')
  assert(escposBytes[0] === 0x1b && escposBytes[1] === 0x40, 'escpos bytes should start with ESC @')
  const escposAscii = escposBytes.toString('ascii')
  assert(escposAscii.includes(`${tag} item`), 'escpos output should contain the line item name')

  // --- 404 for an order with no issued receipt ---
  const { data: unissuedOrder, error: unissuedOrderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 82,
      status: 'new',
      payment_status: 'pending',
      subtotal: 10,
      tax: 1.5,
      total: 11.5,
      items: [],
      channel: 'pos',
    })
    .select('id')
    .single()
  if (unissuedOrderError || !unissuedOrder) throw unissuedOrderError ?? new Error('unissued order insert failed')
  created.orderIds.push(unissuedOrder.id)
  const notFoundReq = new Request(`https://staging.test/api/terminal/receipts/${unissuedOrder.id}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const notFoundRes = await getReceiptRoute(notFoundReq, { params: Promise.resolve({ orderId: unissuedOrder.id }) })
  assert(notFoundRes.status === 404, `GET receipts for unissued order should 404, got ${notFoundRes.status}`)

  // --- POST /api/terminal/receipt-deliveries: append-only, server-derived attempt_number ---
  const { POST: postDeliveryRoute } = await import('../app/api/terminal/receipt-deliveries/route')

  const failedReq = new Request('https://staging.test/api/terminal/receipt-deliveries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receipt_document_id: receipt.id,
      status: 'failed',
      provider: 'bluetooth_escpos',
      error_code: 'PRINTER_UNREACHABLE',
      error_message: 'Printer offline or out of range',
    }),
  })
  const failedRes = await postDeliveryRoute(failedReq)
  assert(failedRes.status === 200, `first delivery attempt should return 200, got ${failedRes.status}`)
  const failedBody = (await failedRes.json()) as { attempt_number: number; status: string }
  assert(failedBody.attempt_number === 1, `first attempt_number should be 1, got ${failedBody.attempt_number}`)
  assert(failedBody.status === 'failed', 'first attempt status should be failed')

  const sentReq = new Request('https://staging.test/api/terminal/receipt-deliveries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receipt_document_id: receipt.id,
      status: 'sent',
      provider: 'bluetooth_escpos',
    }),
  })
  const sentRes = await postDeliveryRoute(sentReq)
  assert(sentRes.status === 200, `second delivery attempt should return 200, got ${sentRes.status}`)
  const sentBody = (await sentRes.json()) as { attempt_number: number; status: string }
  assert(sentBody.attempt_number === 2, `second attempt_number should be server-derived as 2, got ${sentBody.attempt_number}`)
  assert(sentBody.status === 'sent', 'second attempt status should be sent')

  const { data: deliveryRows, error: deliveryRowsError } = await db
    .from('receipt_deliveries')
    .select('id, attempt_number, status')
    .eq('receipt_document_id', receipt.id)
    .order('attempt_number', { ascending: true })
  if (deliveryRowsError) throw deliveryRowsError
  assert(deliveryRows?.length === 2, `expected 2 receipt_deliveries rows, got ${deliveryRows?.length}`)

  // --- GET/POST /api/terminal/printer-config: create then update in place, not duplicate ---
  const { GET: getPrinterConfigRoute, POST: postPrinterConfigRoute } = await import(
    '../app/api/terminal/printer-config/route'
  )

  const emptyConfigReq = new Request('https://staging.test/api/terminal/printer-config', {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const emptyConfigRes = await getPrinterConfigRoute(emptyConfigReq)
  const emptyConfigBody = (await emptyConfigRes.json()) as { config: unknown }
  assert(emptyConfigBody.config === null, 'printer config should be null before pairing')

  const pairReq = new Request('https://staging.test/api/terminal/printer-config', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printer_name: 'TP80N',
      printer_address: '00:11:22:33:44:55',
      paper_width_mm: 80,
      character_width: 48,
    }),
  })
  const pairRes = await postPrinterConfigRoute(pairReq)
  assert(pairRes.status === 200, `printer-config POST should return 200, got ${pairRes.status}`)
  const pairBody = (await pairRes.json()) as { config: { id: string; terminal_id: string; printer_name: string } }
  assert(pairBody.config.terminal_id === terminal.id, 'printer config terminal_id should match')
  assert(pairBody.config.printer_name === 'TP80N', 'printer config printer_name should match')

  const repairReq = new Request('https://staging.test/api/terminal/printer-config', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printer_name: 'D80B',
      printer_address: 'AA:BB:CC:DD:EE:FF',
      paper_width_mm: 80,
      character_width: 42,
    }),
  })
  const repairRes = await postPrinterConfigRoute(repairReq)
  const repairBody = (await repairRes.json()) as { config: { id: string; printer_name: string } }
  assert(repairBody.config.id === pairBody.config.id, 're-pairing should update the same row, not insert a new one')
  assert(repairBody.config.printer_name === 'D80B', 're-pairing should overwrite the printer name')

  const { count: printerConfigCount } = await db
    .from('terminal_printer_configs')
    .select('id', { count: 'exact', head: true })
    .eq('terminal_id', terminal.id)
  assert(printerConfigCount === 1, `expected exactly 1 printer config row, got ${printerConfigCount}`)

  // --- DELETE /api/terminal/printer-config: "forget this printer" ---
  const { DELETE: deletePrinterConfigRoute } = await import('../app/api/terminal/printer-config/route')

  const deleteReq = new Request('https://staging.test/api/terminal/printer-config', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const deleteRes = await deletePrinterConfigRoute(deleteReq)
  assert(deleteRes.status === 200, `printer-config DELETE should return 200, got ${deleteRes.status}`)

  const afterDeleteReq = new Request('https://staging.test/api/terminal/printer-config', {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const afterDeleteRes = await getPrinterConfigRoute(afterDeleteReq)
  const afterDeleteBody = (await afterDeleteRes.json()) as { config: unknown }
  assert(afterDeleteBody.config === null, 'printer config should be null after DELETE')

  const { count: printerConfigCountAfterDelete } = await db
    .from('terminal_printer_configs')
    .select('id', { count: 'exact', head: true })
    .eq('terminal_id', terminal.id)
  assert(printerConfigCountAfterDelete === 0, `expected 0 printer config rows after delete, got ${printerConfigCountAfterDelete}`)

  // Deleting again (nothing to delete) should still succeed, not error -- "forget" is idempotent.
  const deleteAgainRes = await deletePrinterConfigRoute(deleteReq)
  assert(deleteAgainRes.status === 200, `repeat printer-config DELETE should still return 200, got ${deleteAgainRes.status}`)

  console.log('TERMINAL_RECEIPT_PRINT_ROUTES_STAGING_VERIFY_OK', {
    orderId: order.id,
    receiptId: receipt.id,
    terminalId: terminal.id,
    printerConfigId: pairBody.config.id,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('TERMINAL_RECEIPT_PRINT_ROUTES_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
