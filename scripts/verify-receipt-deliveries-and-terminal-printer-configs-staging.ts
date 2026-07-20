/**
 * Staging verification: receipt_deliveries append-only mechanics + terminal_printer_configs
 * with real data (Phase 2 migration only -- does not exercise the print flow itself, which
 * lives in the flashtap-terminal native app).
 *   npx tsx scripts/verify-receipt-deliveries-and-terminal-printer-configs-staging.ts
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

const tag = `rd-${Date.now()}`

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
      // receipt_deliveries.receipt_document_id -> receipt_documents.id must be cleared
      // first, or the receipt_documents (and cascading orders) deletes below fail silently.
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
      table_number: 79,
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

  // --- receipt_deliveries: append-only retry mechanics ---
  const { data: attempt1, error: attempt1Error } = await db
    .from('receipt_deliveries')
    .insert({
      receipt_document_id: receipt.id,
      method: 'PRINT',
      status: 'failed',
      attempt_number: 1,
      provider: 'bluetooth_escpos',
      device_id: `DEVICE-${tag}`,
      error_code: 'PRINTER_UNREACHABLE',
      error_message: 'Printer offline or out of range',
      completed_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (attempt1Error || !attempt1) throw attempt1Error ?? new Error('attempt 1 insert failed')

  const { data: attempt2, error: attempt2Error } = await db
    .from('receipt_deliveries')
    .insert({
      receipt_document_id: receipt.id,
      method: 'PRINT',
      status: 'sent',
      attempt_number: 2,
      provider: 'bluetooth_escpos',
      device_id: `DEVICE-${tag}`,
      completed_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (attempt2Error || !attempt2) throw attempt2Error ?? new Error('attempt 2 insert failed')

  const { data: deliveryRows, error: deliveryRowsError } = await db
    .from('receipt_deliveries')
    .select('id, status, attempt_number')
    .eq('receipt_document_id', receipt.id)
    .order('attempt_number', { ascending: true })
  if (deliveryRowsError) throw deliveryRowsError

  assert(deliveryRows?.length === 2, `expected 2 receipt_deliveries rows, got ${deliveryRows?.length}`)
  assert(deliveryRows[0].status === 'failed' && deliveryRows[0].attempt_number === 1, 'attempt 1 should be failed')
  assert(deliveryRows[1].status === 'sent' && deliveryRows[1].attempt_number === 2, 'attempt 2 should be sent')
  assert(deliveryRows[0].id === attempt1.id, 'attempt 1 row must be the original -- never overwritten')
  assert(deliveryRows[1].id === attempt2.id, 'attempt 2 row must be a new row, not an edit of attempt 1')

  // --- terminal_printer_configs: real device pairing row ---
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
      printer_name: 'TP80N',
      printer_address: '00:11:22:33:44:55',
      paper_width_mm: 80,
      character_width: 48,
    })
    .select('*')
    .single()
  if (printerConfigError || !printerConfig) throw printerConfigError ?? new Error('printer config insert failed')
  created.printerConfigIds.push(printerConfig.id)

  assert(printerConfig.terminal_id === terminal.id, 'printer config terminal_id should match restaurant_terminals.id')
  assert(printerConfig.purpose === 'CUSTOMER_RECEIPT', 'printer config purpose should default to CUSTOMER_RECEIPT')
  assert(printerConfig.connection_type === 'BLUETOOTH', 'printer config connection_type should default to BLUETOOTH')
  assert(printerConfig.is_default === true, 'printer config is_default should default to true')

  const { data: joinedConfig, error: joinedConfigError } = await db
    .from('terminal_printer_configs')
    .select('id, terminal_id, printer_name, printer_address')
    .eq('id', printerConfig.id)
    .single()
  if (joinedConfigError || !joinedConfig) throw joinedConfigError ?? new Error('printer config refetch failed')
  assert(joinedConfig.printer_name === 'TP80N', 'refetched printer config should match what was inserted')

  console.log('RECEIPT_DELIVERIES_AND_TERMINAL_PRINTER_CONFIGS_STAGING_VERIFY_OK', {
    receiptId: receipt.id,
    attempt1Id: attempt1.id,
    attempt2Id: attempt2.id,
    terminalId: terminal.id,
    printerConfigId: printerConfig.id,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('RECEIPT_DELIVERIES_AND_TERMINAL_PRINTER_CONFIGS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
