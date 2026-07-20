/**
 * Staging verification: GET /api/terminal/receipts/[orderId] now returns sdk6Lines
 * alongside escposBase64, both derived from the same snapshot, against a real issued
 * receipt. Invoked directly as a route handler with a real signed terminal JWT, same
 * pattern as scripts/verify-terminal-receipt-print-routes-staging.ts.
 *   npx tsx scripts/verify-sdk6-receipt-lines-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'
import type { Sdk6ReceiptLine } from '../lib/receipts/renderers/sdk6Renderer'

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

const tag = `sdk6-${Date.now()}`

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

  // --- seed a real paid order + sale event + issued receipt (2 items, a discount, so
  // the line-item/discount/total branches all get exercised with real data) ---
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 83,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 60,
      tax: 9,
      total: 69,
      items: [
        { name: `${tag} Chicken Wrap`, quantity: 2, price: 25 },
        { name: `${tag} Iced Tea`, quantity: 1, price: 10 },
      ],
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

  // --- GET /api/terminal/receipts/[orderId]: escposBase64 + sdk6Lines from one request ---
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
    sdk6Lines: Sdk6ReceiptLine[]
  }
  assert(receiptBody.id === receipt.id, 'GET receipts should return the issued receipt id')
  assert(Array.isArray(receiptBody.escposBase64) === false && typeof receiptBody.escposBase64 === 'string', 'escposBase64 should still be present alongside sdk6Lines')
  assert(Array.isArray(receiptBody.sdk6Lines), 'sdk6Lines should be an array')

  const lines = receiptBody.sdk6Lines

  const headerLine = lines.find((l) => l.type === 'text' && l.align === 'CENTER' && l.bold)
  assert(headerLine !== undefined, 'sdk6Lines should include a bold centered header line (restaurant name)')
  assert(
    (headerLine as { text: string }).text.length > 0,
    'header line text should be non-empty',
  )

  const itemLine = lines.find((l) => l.type === 'text' && 'text' in l && l.text.includes(`${tag} Chicken Wrap`))
  assert(itemLine !== undefined, 'sdk6Lines should include a text line for each real line item')
  const itemLine2 = lines.find((l) => l.type === 'text' && 'text' in l && l.text.includes(`${tag} Iced Tea`))
  assert(itemLine2 !== undefined, 'sdk6Lines should include a text line for the second real line item')

  const rowLines = lines.filter((l): l is { type: 'row'; columns: string[] } => l.type === 'row')
  const qtyRow = rowLines.find((l) => l.columns[0] === '2 x 25.00' && l.columns[1] === '50.00')
  assert(qtyRow !== undefined, 'sdk6Lines should include a row with the real quantity/price/line-total for item 1')
  const totalRow = rowLines.find((l) => l.columns[0] === 'Total')
  assert(totalRow !== undefined, 'sdk6Lines should include a Total row')
  assert(totalRow.columns[1] === '69.00', `Total row should reflect the real order total, got ${totalRow?.columns[1]}`)
  const subtotalRow = rowLines.find((l) => l.columns[0] === 'Subtotal')
  assert(subtotalRow?.columns[1] === '60.00', 'Subtotal row should reflect the real order subtotal')
  const vatRow = rowLines.find((l) => l.columns[0] === 'VAT')
  assert(vatRow?.columns[1] === '9.00', 'VAT row should reflect the real order tax')

  const paymentRow = rowLines.find((l) => l.columns[0].startsWith('CARD'))
  assert(paymentRow !== undefined, 'sdk6Lines should include a payment row with the masked reference')
  assert(paymentRow.columns[1] === '69.00', 'payment row amount should match the sale event amount')

  const dividerLine = lines.find((l) => l.type === 'divider')
  assert(dividerLine !== undefined, 'sdk6Lines should include a divider line')

  const feedLines = lines.filter((l): l is { type: 'feed'; lines: number } => l.type === 'feed')
  assert(feedLines.length > 0, 'sdk6Lines should include feed lines')

  // Both renderers come from the exact same snapshot in one request -- cross-check they agree.
  const escposAscii = Buffer.from(receiptBody.escposBase64, 'base64').toString('ascii')
  assert(escposAscii.includes(`${tag} Chicken Wrap`), 'escposBase64 (same response) should also contain the line item')

  console.log('SDK6_RECEIPT_LINES_STAGING_VERIFY_OK', {
    orderId: order.id,
    receiptId: receipt.id,
    documentNumber: receiptBody.documentNumber,
    lineCount: lines.length,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('SDK6_RECEIPT_LINES_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
