/**
 * Staging verification: POST /api/terminal/receipts/[orderId]/email -- terminal-JWT-
 * authenticated mirror of the staff-facing receipt email route, invoked directly as a
 * route handler with a real signed terminal JWT (jose), against a real issued receipt,
 * with a real Resend send (same as scripts/verify-receipt-dashboard-actions-staging.mjs
 * verified the staff-facing version).
 *   npx tsx scripts/verify-terminal-receipt-email-staging.ts
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
if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY missing -- set in .env.local')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `term-email-${Date.now()}`
const recipientEmail = process.env.RECEIPT_E2E_EMAIL || 'xshadoey@gmail.com'

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

  // --- seed a real paid, completed order + sale event ---
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 84,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 45,
      tax: 6.75,
      total: 51.75,
      items: [{ name: `${tag} Pizza Slice`, quantity: 1, price: 45 }],
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
    amount: 51.75,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleError) throw saleError

  // No receipt issued yet -- exercises the "issue on demand" branch, same as the route
  // must handle since issuance-at-payment-completion is fire-and-forget.
  const { data: preExisting } = await db
    .from('receipt_documents')
    .select('id')
    .eq('order_id', order.id)
    .eq('document_type', 'SALE_RECEIPT')
    .maybeSingle()
  assert(!preExisting, 'test order should not already have a receipt before the route call')

  // --- POST /api/terminal/receipts/[orderId]/email: real terminal JWT, real Resend send ---
  const { POST: postTerminalReceiptEmail } = await import(
    '../app/api/terminal/receipts/[orderId]/email/route'
  )
  const emailReq = new Request(`https://staging.test/api/terminal/receipts/${order.id}/email`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: recipientEmail }),
  })
  const emailRes = await postTerminalReceiptEmail(emailReq, { params: Promise.resolve({ orderId: order.id }) })
  const emailBody = (await emailRes.json()) as { success?: boolean; deliveryId?: string; error?: string }
  console.log('response', { status: emailRes.status, body: emailBody })
  assert(emailRes.status === 200, `terminal receipt email POST should return 200, got ${emailRes.status}: ${emailBody.error ?? ''}`)
  assert(emailBody.success === true, 'response should report success: true')
  assert(typeof emailBody.deliveryId === 'string' && emailBody.deliveryId.length > 0, 'response should include a deliveryId')

  // --- cross-tenant guard: a JWT for TEST_RESTAURANT_ID must not touch another restaurant's order ---
  const { data: otherRestaurant } = await db
    .from('restaurants')
    .select('id')
    .neq('id', TEST_RESTAURANT_ID)
    .limit(1)
    .maybeSingle()
  if (otherRestaurant?.id) {
    const { data: otherOrder } = await db
      .from('orders')
      .select('id')
      .eq('restaurant_id', otherRestaurant.id)
      .eq('payment_status', 'paid')
      .limit(1)
      .maybeSingle()
    if (otherOrder?.id) {
      const crossReq = new Request(`https://staging.test/api/terminal/receipts/${otherOrder.id}/email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recipientEmail }),
      })
      const crossRes = await postTerminalReceiptEmail(crossReq, { params: Promise.resolve({ orderId: otherOrder.id }) })
      assert(crossRes.status === 404, `cross-tenant order access should 404, got ${crossRes.status}`)
    }
  }

  // --- Real DB confirmation: receipt issued on demand + receipt_deliveries logged via the SAME adapter ---
  const { data: receipt } = await db
    .from('receipt_documents')
    .select('id, document_number')
    .eq('order_id', order.id)
    .eq('document_type', 'SALE_RECEIPT')
    .single()
  assert(receipt, 'receipt_documents row should now exist (issued on demand by the route)')

  const { data: deliveries } = await db
    .from('receipt_deliveries')
    .select('id, method, status, destination, provider, attempt_number')
    .eq('receipt_document_id', receipt.id)
    .eq('method', 'EMAIL')
    .order('attempt_number', { ascending: false })
    .limit(1)

  assert(deliveries?.length === 1, 'exactly one EMAIL receipt_deliveries row should exist')
  assert(deliveries[0].id === emailBody.deliveryId, 'logged delivery id should match the one returned by the route')
  assert(deliveries[0].status === 'sent', `EMAIL delivery status should be sent, got ${deliveries[0].status}`)
  assert(deliveries[0].destination === recipientEmail, 'destination should match the address sent in the request body')
  assert(deliveries[0].provider === 'resend', 'provider should be resend -- same sendReceiptEmail adapter as the staff route')

  console.log('TERMINAL_RECEIPT_EMAIL_STAGING_VERIFY_OK', {
    orderId: order.id,
    receiptId: receipt.id,
    documentNumber: receipt.document_number,
    deliveryId: deliveries[0].id,
    recipientEmail,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('TERMINAL_RECEIPT_EMAIL_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
