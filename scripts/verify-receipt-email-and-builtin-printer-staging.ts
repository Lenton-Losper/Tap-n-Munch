/**
 * Staging verification: receipt_deliveries.method='EMAIL' and
 * terminal_printer_configs.connection_type='BUILTIN' are now accepted (Phase 3 prep only --
 * does not exercise the email adapter or built-in-printer flow, those are verified separately).
 *   npx tsx scripts/verify-receipt-email-and-builtin-printer-staging.ts
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

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `rceb-${Date.now()}`

const created = {
  orderIds: [] as string[],
  terminalIds: [] as string[],
  printerConfigIds: [] as string[],
}

async function cleanup() {
  if (created.printerConfigIds.length) {
    await db.from('terminal_printer_configs').delete().in('id', created.printerConfigIds)
  }
  if (created.terminalIds.length) {
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
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 80,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 40,
      tax: 6,
      total: 46,
      items: [{ name: `${tag} item`, quantity: 1, price: 40 }],
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
    terminal_id: 'TERM-TEST',
    amount: 46,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleError) throw saleError

  const receipt = await issueReceiptForOrder(order.id)

  // --- receipt_deliveries.method = 'EMAIL' now accepted ---
  const { data: emailDelivery, error: emailDeliveryError } = await db
    .from('receipt_deliveries')
    .insert({
      receipt_document_id: receipt.id,
      method: 'EMAIL',
      status: 'sent',
      attempt_number: 1,
      provider: 'resend',
      destination: `verify-${tag}@example.com`,
      completed_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (emailDeliveryError || !emailDelivery) {
    throw emailDeliveryError ?? new Error('EMAIL delivery insert failed')
  }
  assert(emailDelivery.method === 'EMAIL', 'delivery method should be EMAIL')

  // --- terminal_printer_configs.connection_type = 'BUILTIN' now accepted ---
  const { data: terminal, error: terminalError } = await db
    .from('restaurant_terminals')
    .insert({ restaurant_id: TEST_RESTAURANT_ID, device_id: `DEVICE-${tag}`, name: `${tag} terminal` })
    .select('id')
    .single()
  if (terminalError || !terminal) throw terminalError ?? new Error('terminal insert failed')
  created.terminalIds.push(terminal.id)

  const { data: printerConfig, error: printerConfigError } = await db
    .from('terminal_printer_configs')
    .insert({
      terminal_id: terminal.id,
      connection_type: 'BUILTIN',
      printer_name: 'P5 Built-in',
      paper_width_mm: 58,
      character_width: 32,
    })
    .select('*')
    .single()
  if (printerConfigError || !printerConfig) {
    throw printerConfigError ?? new Error('BUILTIN printer config insert failed')
  }
  created.printerConfigIds.push(printerConfig.id)
  assert(printerConfig.connection_type === 'BUILTIN', 'connection_type should be BUILTIN')

  // Existing values must still be accepted (widening, not replacing).
  const { error: printStillOkError } = await db.from('receipt_deliveries').insert({
    receipt_document_id: receipt.id,
    method: 'PRINT',
    status: 'sent',
    attempt_number: 2,
    provider: 'bluetooth_escpos',
    completed_at: new Date().toISOString(),
  })
  if (printStillOkError) throw printStillOkError

  console.log('RECEIPT_EMAIL_AND_BUILTIN_PRINTER_STAGING_VERIFY_OK', {
    receiptId: receipt.id,
    emailDeliveryId: emailDelivery.id,
    printerConfigId: printerConfig.id,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('RECEIPT_EMAIL_AND_BUILTIN_PRINTER_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
