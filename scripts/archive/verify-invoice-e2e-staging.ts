/**
 * Staging E2E: checkout invoice opt-in + staff-requested invoice with real PDF/email delivery.
 *
 *   npx tsx scripts/apply-drop-invoice-preference-staging.ts   (once)
 *   npx tsx scripts/verify-invoice-e2e-staging.ts
 *
 * Requires RESEND_API_KEY (loads .env.local after .env.test). Set INVOICE_E2E_EMAIL to override recipient.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
  activatePendingInvoiceRequestOnPayment,
  createPendingCheckoutInvoiceRequest,
} from '../lib/invoices/checkout-invoice-request'
import { requestInvoice } from '../lib/invoices/request-invoice'
import { runInvoiceGenerationNow } from '../lib/invoices/schedule-invoice-generation'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })
const stagingSupabaseUrl = process.env.SUPABASE_URL!
const stagingServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
config({ path: '.env.local', override: false })

process.env.SUPABASE_URL = stagingSupabaseUrl
process.env.NEXT_PUBLIC_SUPABASE_URL = stagingSupabaseUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = stagingServiceRoleKey

delete process.env.INVOICE_SKIP_EMAIL
delete process.env.INVOICE_SKIP_STORAGE

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = stagingSupabaseUrl
}

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = stagingSupabaseUrl
const serviceKey = stagingServiceRoleKey
const bucket = process.env.SUPABASE_INVOICE_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || 'menu-images'

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}
if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is required for invoice E2E delivery verification')
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `e2e-inv-${Date.now()}`
const recipientEmail = String(process.env.INVOICE_E2E_EMAIL || `invoice-e2e+${tag}@flashtap.app`).trim()

const created = {
  orderIds: [] as string[],
  paymentIds: [] as string[],
  invoiceRequestIds: [] as string[],
}

async function ensureStorageBucket() {
  const { data: buckets, error } = await db.storage.listBuckets()
  if (error) throw error
  if (buckets?.some((row) => row.name === bucket)) return

  const { error: createError } = await db.storage.createBucket(bucket, { public: false })
  if (createError && !String(createError.message).toLowerCase().includes('already exists')) {
    throw createError
  }
}

async function cleanup() {
  if (created.invoiceRequestIds.length) {
    for (const id of created.invoiceRequestIds) {
      const { data: row } = await db.from('invoice_requests').select('pdf_url').eq('id', id).maybeSingle()
      if (row?.pdf_url) {
        await db.storage.from(bucket).remove([String(row.pdf_url)])
      }
    }
    await db.from('invoice_requests').delete().in('id', created.invoiceRequestIds)
  }
  if (created.paymentIds.length) {
    await db.from('payments').delete().in('id', created.paymentIds)
  }
  if (created.orderIds.length) {
    await db.from('invoice_requests').delete().in('order_id', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
}

async function seedUnpaidOrder(total: number, suffix: string) {
  const { data: order, error } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 88,
      status: 'pending',
      payment_status: 'pending',
      subtotal: total,
      tax: 0,
      total,
      items: [
        {
          name: `E2E Item ${suffix}`,
          quantity: 1,
          subtotal: total,
        },
      ],
    })
    .select('id')
    .single()

  if (error || !order?.id) throw error || new Error('Failed to seed order')
  created.orderIds.push(order.id)
  return order.id
}

async function markOrderPaid(orderId: string, reference: string) {
  const paidAt = new Date().toISOString()
  const { error } = await db
    .from('orders')
    .update({
      status: 'completed',
      payment_status: 'paid',
      paid_at: paidAt,
      completed_at: paidAt,
      payment_reference: reference,
    })
    .eq('id', orderId)

  if (error) throw error
}

async function seedPayment(orderId: string, amount: number, reference: string) {
  const { data: payment, error } = await db
    .from('payments')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      order_ids: [orderId],
      amount,
      method: 'cash',
      status: 'completed',
      payment_reference: reference,
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !payment?.id) throw error || new Error('Failed to seed payment')
  created.paymentIds.push(payment.id)
  return payment.id
}

async function waitForInvoiceSent(invoiceRequestId: string, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const { data: row } = await db
      .from('invoice_requests')
      .select('id, status, invoice_number, pdf_url, email')
      .eq('id', invoiceRequestId)
      .maybeSingle()

    if (row?.status === 'sent' && row.pdf_url && row.invoice_number) {
      return row
    }
    if (row?.status === 'failed') {
      throw new Error(`Invoice generation failed for ${invoiceRequestId}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for invoice ${invoiceRequestId} to reach sent`)
}

async function assertPdfDownloadable(pdfPath: string) {
  const { data, error } = await db.storage.from(bucket).download(pdfPath)
  if (error || !data) {
    throw new Error(`PDF download failed: ${error?.message || 'missing file'}`)
  }
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (bytes.length < 100) {
    throw new Error('Downloaded PDF is too small')
  }
}

async function main() {
  await ensureStorageBucket()

  const { data: restaurant } = await db
    .from('restaurants')
    .select('short_code, name')
    .eq('id', TEST_RESTAURANT_ID)
    .maybeSingle()

  const shortCode = String(restaurant?.short_code || 'FT').trim().toUpperCase()

  const checkoutDetails = {
    email: recipientEmail,
    company_name: 'E2E Checkout Corp',
    vat_number: 'VAT-E2E-1',
  }

  const checkoutOrderId = await seedUnpaidOrder(125.5, 'checkout')

  const checkoutPending = await createPendingCheckoutInvoiceRequest(db, {
    orderId: checkoutOrderId,
    restaurantId: TEST_RESTAURANT_ID,
    details: checkoutDetails,
  })
  created.invoiceRequestIds.push(checkoutPending.invoiceRequestId)

  const { data: pendingRow } = await db
    .from('invoice_requests')
    .select('id, status, payment_id, source')
    .eq('id', checkoutPending.invoiceRequestId)
    .single()

  if (pendingRow?.status !== 'pending' || pendingRow?.source !== 'checkout') {
    throw new Error('Checkout opt-in should create a pending checkout invoice_requests row')
  }
  if (pendingRow?.payment_id) {
    throw new Error('Checkout invoice request should not have payment_id before payment')
  }

  const checkoutPaymentRef = `${tag}-checkout-pay`
  await markOrderPaid(checkoutOrderId, checkoutPaymentRef)
  const checkoutPaymentId = await seedPayment(checkoutOrderId, 125.5, checkoutPaymentRef)

  await activatePendingInvoiceRequestOnPayment(db, {
    orderId: checkoutOrderId,
    restaurantId: TEST_RESTAURANT_ID,
    paymentId: checkoutPaymentId,
    paymentReference: checkoutPaymentRef,
    skipGenerationSchedule: true,
  })

  await runInvoiceGenerationNow(checkoutPending.invoiceRequestId)
  const checkoutSent = await waitForInvoiceSent(checkoutPending.invoiceRequestId)

  if (String(checkoutSent.email).toLowerCase() !== recipientEmail.toLowerCase()) {
    throw new Error(`Checkout invoice email mismatch: ${checkoutSent.email}`)
  }
  if (!String(checkoutSent.invoice_number).startsWith(`INV-${shortCode}-`)) {
    throw new Error(`Unexpected checkout invoice number: ${checkoutSent.invoice_number}`)
  }
  await assertPdfDownloadable(String(checkoutSent.pdf_url))

  const staffOrderId = await seedUnpaidOrder(75, 'staff')
  await markOrderPaid(staffOrderId, `${tag}-staff-pay`)
  const staffPaymentRef = `${tag}-staff-pay`
  const staffPaymentId = await seedPayment(staffOrderId, 75, staffPaymentRef)

  const staffResult = await requestInvoice(db, {
    orderId: staffOrderId,
    paymentId: staffPaymentId,
    source: 'staff',
    idempotencyKey: `invoice:staff:${staffOrderId}`,
    skipGenerationSchedule: true,
    details: {
      email: recipientEmail,
      company_name: 'E2E Staff Corp',
      vat_number: 'VAT-E2E-2',
    },
  })

  created.invoiceRequestIds.push(staffResult.invoiceRequestId)
  await runInvoiceGenerationNow(staffResult.invoiceRequestId)
  const staffSent = await waitForInvoiceSent(staffResult.invoiceRequestId)

  if (!String(staffSent.invoice_number).startsWith(`INV-${shortCode}-`)) {
    throw new Error(`Unexpected staff invoice number: ${staffSent.invoice_number}`)
  }

  const checkoutSeq = Number(String(checkoutSent.invoice_number).split('-').pop())
  const staffSeq = Number(String(staffSent.invoice_number).split('-').pop())
  if (!Number.isFinite(checkoutSeq) || !Number.isFinite(staffSeq) || staffSeq <= checkoutSeq) {
    throw new Error(
      `Staff invoice number should follow checkout sequence: ${checkoutSent.invoice_number} -> ${staffSent.invoice_number}`,
    )
  }

  await assertPdfDownloadable(String(staffSent.pdf_url))

  console.log('INVOICE_E2E_STAGING_VERIFY_OK', {
    recipientEmail,
    checkoutInvoiceNumber: checkoutSent.invoice_number,
    staffInvoiceNumber: staffSent.invoice_number,
    restaurantName: restaurant?.name,
    note: 'Pending checkout row activated on payment; Resend delivered both PDFs',
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('INVOICE_E2E_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
