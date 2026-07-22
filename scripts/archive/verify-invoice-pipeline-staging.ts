/**
 * Staging verification: invoice request + generation pipeline.
 *   npx tsx scripts/apply-invoice-source-staging.ts   (once, if needed)
 *   npx tsx scripts/verify-invoice-pipeline-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { generateTaxInvoicePdfBytes } from '../lib/invoices/generate-tax-invoice-pdf'
import { requestInvoice } from '../lib/invoices/request-invoice'
import { runInvoiceGenerationNow } from '../lib/invoices/schedule-invoice-generation'
import {
  activatePendingInvoiceRequestOnPayment,
  createPendingCheckoutInvoiceRequest,
} from '../lib/invoices/checkout-invoice-request'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

process.env.INVOICE_SKIP_EMAIL = 'true'
process.env.INVOICE_SKIP_STORAGE = 'true'
if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `inv-${Date.now()}`
const shortCode = `T${String(Date.now()).slice(-2)}`

const created = {
  orderIds: [] as string[],
  paymentIds: [] as string[],
  invoiceRequestIds: [] as string[],
}

async function cleanup() {
  if (created.invoiceRequestIds.length) {
    for (const id of created.invoiceRequestIds) {
      const { data: row } = await db.from('invoice_requests').select('pdf_url').eq('id', id).maybeSingle()
      if (row?.pdf_url) {
        await db.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'menu-images').remove([String(row.pdf_url)])
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
  await db
    .from('document_sequences')
    .delete()
    .eq('restaurant_id', TEST_RESTAURANT_ID)
    .eq('sequence_type', 'invoice')
}

async function seedOrder(total: number, suffix: string, paymentStatus: 'paid' | 'pending' = 'paid') {
  const { data: order, error } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 77,
      status: paymentStatus === 'paid' ? 'completed' : 'pending',
      payment_status: paymentStatus,
      paid_at: paymentStatus === 'paid' ? new Date().toISOString() : null,
      subtotal: total,
      tax: 0,
      total,
      items: [
        {
          name: `${tag} Item ${suffix}`,
          quantity: 1,
          subtotal: total,
          basePrice: total,
        },
      ],
      channel: 'pos',
    })
    .select('id')
    .single()

  if (error || !order) throw error ?? new Error('order insert failed')
  created.orderIds.push(order.id)
  return order.id
}

async function seedPayment(orderId: string, amount: number, reference: string) {
  const { data: payment, error } = await db
    .from('payments')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      order_ids: [orderId],
      amount,
      method: 'card',
      status: 'completed',
      payment_reference: reference,
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !payment) throw error ?? new Error('payment insert failed')
  created.paymentIds.push(payment.id)
  return payment.id
}

async function main() {
  await cleanup()

  await db
    .from('restaurants')
    .update({
      short_code: shortCode,
      company_reg_number: 'CC/2024/12345',
      vat_number: 'VAT123456789',
      address: '123 Test Street, Windhoek',
      tax_rate: 15,
    })
    .eq('id', TEST_RESTAURANT_ID)

  const orderA = await seedOrder(100, 'A', 'pending')
  const paymentRefA = `${tag}-pay-a`

  const checkoutPendingA = await createPendingCheckoutInvoiceRequest(db, {
    orderId: orderA,
    restaurantId: TEST_RESTAURANT_ID,
    details: {
      email: `${tag}.checkout@flashtap-test.invalid`,
      company_name: 'Checkout Corp',
      vat_number: 'VAT-CO-1',
      metadata: { department: 'Finance' },
    },
  })
  created.invoiceRequestIds.push(checkoutPendingA.invoiceRequestId)

  await db
    .from('orders')
    .update({
      status: 'completed',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .eq('id', orderA)

  const paymentA = await seedPayment(orderA, 100, paymentRefA)

  await activatePendingInvoiceRequestOnPayment(db, {
    orderId: orderA,
    restaurantId: TEST_RESTAURANT_ID,
    paymentId: paymentA,
    paymentReference: paymentRefA,
    skipGenerationSchedule: true,
  })

  await runInvoiceGenerationNow(checkoutPendingA.invoiceRequestId)

  await activatePendingInvoiceRequestOnPayment(db, {
    orderId: orderA,
    restaurantId: TEST_RESTAURANT_ID,
    paymentId: paymentA,
    paymentReference: paymentRefA,
    skipGenerationSchedule: true,
  })

  const { count: checkoutDupCount } = await db
    .from('invoice_requests')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderA)

  if (checkoutDupCount !== 1) {
    throw new Error(`Expected 1 checkout invoice row, got ${checkoutDupCount}`)
  }

  const orderB = await seedOrder(50, 'B', 'pending')

  const checkoutPendingB = await createPendingCheckoutInvoiceRequest(db, {
    orderId: orderB,
    restaurantId: TEST_RESTAURANT_ID,
    details: {
      email: `${tag}.checkout-b@flashtap-test.invalid`,
      company_name: 'Second Corp',
    },
  })
  created.invoiceRequestIds.push(checkoutPendingB.invoiceRequestId)

  await db
    .from('orders')
    .update({
      status: 'completed',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .eq('id', orderB)

  const paymentRefB = `${tag}-pay-b`
  const paymentB = await seedPayment(orderB, 50, paymentRefB)

  await activatePendingInvoiceRequestOnPayment(db, {
    orderId: orderB,
    restaurantId: TEST_RESTAURANT_ID,
    paymentId: paymentB,
    paymentReference: paymentRefB,
    skipGenerationSchedule: true,
  })
  await runInvoiceGenerationNow(checkoutPendingB.invoiceRequestId)

  const { data: sentRows } = await db
    .from('invoice_requests')
    .select('id, invoice_number, status, pdf_url, source')
    .in('id', [checkoutPendingA.invoiceRequestId, checkoutPendingB.invoiceRequestId])
    .order('invoice_number')

  if ((sentRows ?? []).length !== 2) {
    throw new Error('Expected two generated invoice requests')
  }

  for (const row of sentRows ?? []) {
    if (row.status !== 'sent' || !row.pdf_url) {
      throw new Error(`Invoice ${row.id} not sent: status=${row.status}`)
    }
  }

  const numA = String(sentRows?.[0]?.invoice_number || '')
  const numB = String(sentRows?.[1]?.invoice_number || '')
  if (!numA.startsWith(`INV-${shortCode}-`) || !numB.startsWith(`INV-${shortCode}-`)) {
    throw new Error(`Unexpected invoice numbers: ${numA}, ${numB}`)
  }

  const seqA = Number(numA.split('-').pop())
  const seqB = Number(numB.split('-').pop())
  if (!Number.isFinite(seqA) || !Number.isFinite(seqB) || seqB !== seqA + 1) {
    throw new Error(`Invoice numbers did not increment sequentially: ${numA} -> ${numB}`)
  }

  for (const row of sentRows ?? []) {
    if (process.env.INVOICE_SKIP_STORAGE === 'true') {
      if (!row.pdf_url) throw new Error(`Missing pdf_url for ${row.id}`)
      const bytes = await generateTaxInvoicePdfBytes({
        seller: { name: 'Test' },
        invoiceNumber: String(row.invoice_number),
        invoiceDate: new Date().toISOString(),
        billTo: { email: 'test@test.invalid', metadata: {} },
        lineItems: [{ description: 'Test', quantity: 1, unitPrice: 1, lineTotal: 1 }],
        subtotal: 1,
        vatAmount: 0,
        total: 1,
        currency: 'NAD',
      })
      if (bytes.length < 100) throw new Error('PDF generation produced empty output')
      continue
    }

    const { data: file, error: downloadError } = await db.storage
      .from(process.env.SUPABASE_STORAGE_BUCKET || 'menu-images')
      .download(String(row.pdf_url))

    if (downloadError || !file) {
      throw new Error(`PDF missing for ${row.id}: ${downloadError?.message}`)
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length < 100) throw new Error(`Invalid PDF for ${row.id}`)
  }

  const staff1 = await requestInvoice(db, {
    orderId: orderB,
    paymentId: paymentB,
    source: 'staff',
    idempotencyKey: `invoice:staff:${orderB}`,
    details: {
      email: `${tag}.staff@flashtap-test.invalid`,
      company_name: 'Staff Resend Corp',
      metadata: { gl_number: 'GL-9001', cost_centre: 'CC-42' },
    },
  })

  if (!staff1.isResend || staff1.invoiceRequestId !== checkoutPendingB.invoiceRequestId) {
    throw new Error('Staff request on invoiced order should resend existing row')
  }

  const staff2 = await requestInvoice(db, {
    orderId: orderB,
    paymentId: paymentB,
    source: 'staff',
    idempotencyKey: `invoice:staff:${orderB}`,
    details: {
      email: `${tag}.staff@flashtap-test.invalid`,
      company_name: 'Staff Resend Corp',
    },
  })

  if (!staff2.isResend || staff2.invoiceRequestId !== checkoutPendingB.invoiceRequestId) {
    throw new Error('Staff resend should return the existing invoice request')
  }

  const { count: orderBInvoiceCount } = await db
    .from('invoice_requests')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderB)

  if (orderBInvoiceCount !== 1) {
    throw new Error(`Expected 1 invoice row for order B after staff resend, got ${orderBInvoiceCount}`)
  }

  console.log('INVOICE_PIPELINE_STAGING_VERIFY_OK', {
    checkoutInvoiceNumbers: [numA, numB],
    checkoutDuplicatePrevented: checkoutDupCount === 1,
    staffResend: staff2.isResend,
    pdfGenerated: (sentRows ?? []).length,
  })

  await cleanup()

  await db
    .from('restaurants')
    .update({
      short_code: null,
      company_reg_number: null,
      vat_number: null,
    })
    .eq('id', TEST_RESTAURANT_ID)
}

main().catch(async (error) => {
  console.error('INVOICE_PIPELINE_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
