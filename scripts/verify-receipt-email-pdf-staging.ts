/**
 * Staging verification: sendReceiptEmail now attaches a real PDF (pdf-lib) alongside the
 * improved HTML body, via a real Resend send against a real issued receipt.
 *   npx tsx scripts/verify-receipt-email-pdf-staging.ts
 *
 * Also writes the exact PDF bytes attached to the real email to
 * scripts/.out-receipt-email-pdf-check.pdf for a visual open/inspect pass (renderReceiptPdf
 * is a pure function of the snapshot + document metadata, so re-deriving it from the same
 * issued receipt reproduces the identical bytes that were attached).
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { writeFileSync } from 'fs'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })
config({ path: '.env.local', override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}
if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY missing -- set in .env.local')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `pdf-email-${Date.now()}`
const recipientEmail = process.env.RECEIPT_E2E_EMAIL || 'xshadoey@gmail.com'

const created = { orderIds: [] as string[] }

async function cleanup() {
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
      table_number: 85,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subtotal: 90,
      tax: 13.5,
      total: 103.5,
      items: [
        { name: `${tag} Springbok Steak`, quantity: 1, price: 68 },
        { name: `${tag} House Red (glass)`, quantity: 2, price: 11 },
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
    terminal_id: 'TERM-PDF-TEST',
    amount: 103.5,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleError) throw saleError

  const { issueReceiptForOrder } = await import('../lib/receipts/issueReceipt')
  const receipt = await issueReceiptForOrder(order.id)

  const { sendReceiptEmail } = await import('../lib/receipts/delivery/sendReceiptEmail')
  const result = await sendReceiptEmail(receipt, recipientEmail)
  console.log('sendReceiptEmail result:', result)

  assert(result.status === 'sent', `expected status 'sent', got '${result.status}' (${result.errorMessage})`)

  const { data: deliveries } = await db
    .from('receipt_deliveries')
    .select('id, method, status, destination, provider')
    .eq('receipt_document_id', receipt.id)
    .eq('method', 'EMAIL')
    .order('attempt_number', { ascending: false })
    .limit(1)
  assert(deliveries?.length === 1, 'exactly one EMAIL receipt_deliveries row should exist')
  assert(deliveries[0].status === 'sent', 'logged delivery status should be sent')
  assert(deliveries[0].destination === recipientEmail, 'logged destination should match')

  // Re-derive the exact same PDF bytes that were attached (renderReceiptPdf is a pure
  // function of the snapshot + document metadata, both fixed once the receipt is issued)
  // and write them out for a visual open/inspect pass.
  const { renderReceiptPdf } = await import('../lib/receipts/renderers/pdfRenderer')
  const pdfBytes = await renderReceiptPdf(receipt.snapshot_json as any, {
    documentNumber: receipt.document_number,
    issuedAt: receipt.issued_at,
  })
  const outPath = 'scripts/.out-receipt-email-pdf-check.pdf'
  writeFileSync(outPath, Buffer.from(pdfBytes))

  console.log('RECEIPT_EMAIL_PDF_STAGING_VERIFY_OK', {
    orderId: order.id,
    receiptId: receipt.id,
    documentNumber: receipt.document_number,
    deliveryId: deliveries[0].id,
    recipientEmail,
    pdfBytesLength: pdfBytes.length,
    pdfWrittenTo: outPath,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('RECEIPT_EMAIL_PDF_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
