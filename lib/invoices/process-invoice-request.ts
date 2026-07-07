import { createServerSupabaseClient } from '@/lib/supabase/server'
import { generateTaxInvoicePdfBytes, type TaxInvoiceLineItem } from '@/lib/invoices/generate-tax-invoice-pdf'
import { notifyManagersInvoiceFailure } from '@/lib/invoices/notify-invoice-failure'
import { emitInvoiceGenerated } from '@/lib/events/emit-invoice-generated'
import { randomUUID } from 'crypto'

const INVOICE_BUCKET = process.env.SUPABASE_INVOICE_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || 'menu-images'
const MAX_RETRY_COUNT = 3

type OrderLineItem = {
  name?: string
  displayName?: string
  quantity?: number
  subtotal?: number
  basePrice?: number
  base_price?: number
  menuItemId?: string
  menu_item_id?: string
}

function parseLineItems(raw: unknown): TaxInvoiceLineItem[] {
  if (!Array.isArray(raw)) return []

  return raw.map((entry) => {
    const item = entry as OrderLineItem
    const qty = Number(item.quantity)
    const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1
    const subtotal = Number(item.subtotal)
    const unitFromFields = Number(item.basePrice ?? item.base_price)
    const lineTotal = Number.isFinite(subtotal)
      ? subtotal
      : Number.isFinite(unitFromFields)
        ? unitFromFields * quantity
        : 0
    const unitPrice = quantity > 0 ? lineTotal / quantity : lineTotal

    return {
      description: String(item.displayName || item.name || 'Item').trim() || 'Item',
      quantity,
      unitPrice: Math.round(unitPrice * 100) / 100,
      lineTotal: Math.round(lineTotal * 100) / 100,
    }
  })
}

function resolveShortCode(restaurant: Record<string, unknown>): string {
  const code = String(restaurant.short_code || '').trim()
  if (code) return code.toUpperCase()
  const slug = String(restaurant.slug || '').trim()
  if (slug) return slug.slice(0, 3).toUpperCase()
  return 'FT'
}

async function markFailed(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  invoiceRequestId: string,
  currentRetryCount: number,
  reason: string,
  notify: {
    restaurantId: string
    restaurantName: string
    orderId: string
    invoiceNumber: string | null
  },
): Promise<void> {
  const nextRetry = currentRetryCount + 1

  await supabase
    .from('invoice_requests')
    .update({
      status: 'failed',
      failure_reason: reason.slice(0, 500),
      retry_count: nextRetry,
    })
    .eq('id', invoiceRequestId)

  if (nextRetry >= MAX_RETRY_COUNT) {
    await notifyManagersInvoiceFailure({
      restaurantId: notify.restaurantId,
      restaurantName: notify.restaurantName,
      invoiceRequestId,
      orderId: notify.orderId,
      invoiceNumber: notify.invoiceNumber,
      failureReason: reason,
    })
  }
}

export async function processInvoiceRequest(
  invoiceRequestId: string,
  options?: { attempt?: number },
): Promise<void> {
  const supabase = createServerSupabaseClient()
  const trimmedId = String(invoiceRequestId || '').trim()
  if (!trimmedId) throw new Error('invoice_request_id is required')

  const { data: request, error: loadError } = await supabase
    .from('invoice_requests')
    .select('*')
    .eq('id', trimmedId)
    .maybeSingle()

  if (loadError) throw loadError
  if (!request) throw new Error('Invoice request not found')

  if (request.status === 'sent' && request.pdf_url) {
    return
  }

  if (request.status === 'generating' && request.pdf_url) {
    return
  }

  if (request.status !== 'generating') {
    const { data: locked, error: lockError } = await supabase
      .from('invoice_requests')
      .update({ status: 'generating' })
      .eq('id', trimmedId)
      .in('status', ['pending', 'failed'])
      .select('id')
      .maybeSingle()

    if (lockError) throw lockError
    if (!locked) {
      const { data: latest } = await supabase
        .from('invoice_requests')
        .select('status, pdf_url')
        .eq('id', trimmedId)
        .maybeSingle()
      if (latest?.status === 'sent' && latest.pdf_url) return
      if (latest?.status === 'generating' && !latest.pdf_url) {
        // Another worker marked generating — continue below.
      } else {
        throw new Error('Invoice request is not eligible for generation')
      }
    }
  }

  const retryCount = Number(request.retry_count ?? 0)
  const attempt = options?.attempt ?? retryCount + 1

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, items, subtotal, tax, total, placed_at, paid_at')
    .eq('id', request.order_id)
    .maybeSingle()

  if (orderError) throw orderError
  if (!order) throw new Error('Order not found for invoice request')

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select(
      'id, name, address, phone, currency, tax_rate, short_code, slug, company_reg_number, vat_number',
    )
    .eq('id', request.restaurant_id)
    .maybeSingle()

  if (restaurantError) throw restaurantError
  if (!restaurant) throw new Error('Restaurant not found for invoice request')

  const notifyContext = {
    restaurantId: String(request.restaurant_id),
    restaurantName: String(restaurant.name),
    orderId: String(request.order_id),
    invoiceNumber: request.invoice_number ? String(request.invoice_number) : null,
  }

  try {
    const { data: freshRequest, error: freshError } = await supabase
      .from('invoice_requests')
      .select('invoice_number')
      .eq('id', trimmedId)
      .single()

    if (freshError) throw freshError

    let invoiceNumber = freshRequest.invoice_number ? String(freshRequest.invoice_number) : null

    if (!invoiceNumber) {
      const shortCode = resolveShortCode(restaurant as Record<string, unknown>)
      const { data: docNumber, error: docError } = await supabase.rpc('generate_document_number', {
        p_restaurant_id: request.restaurant_id,
        p_restaurant_code: shortCode,
        p_sequence_type: 'invoice',
        p_prefix: 'INV',
      })

      if (docError) throw docError
      invoiceNumber = String(docNumber || '').trim()
      if (!invoiceNumber) throw new Error('Document number generation returned empty value')

      await supabase
        .from('invoice_requests')
        .update({ invoice_number: invoiceNumber })
        .eq('id', trimmedId)
        .is('invoice_number', null)
    }

    const lineItems = parseLineItems(order.items)
    const subtotal = Number(order.subtotal ?? lineItems.reduce((sum, row) => sum + row.lineTotal, 0))
    const taxRate = Number(restaurant.tax_rate ?? 0)
    const taxFromOrder = Number(order.tax)
    const vatAmount = Number.isFinite(taxFromOrder)
      ? taxFromOrder
      : Math.round(subtotal * (taxRate / 100) * 100) / 100
    const total = Number(order.total ?? subtotal + vatAmount)
    const currency = String(restaurant.currency || 'NAD')

    const pdfBytes = await generateTaxInvoicePdfBytes({
      seller: {
        name: String(restaurant.name),
        companyRegNumber: restaurant.company_reg_number ? String(restaurant.company_reg_number) : null,
        address: restaurant.address ? String(restaurant.address) : null,
        vatNumber: restaurant.vat_number ? String(restaurant.vat_number) : null,
        phone: restaurant.phone ? String(restaurant.phone) : null,
      },
      invoiceNumber,
      invoiceDate: String(order.paid_at || order.placed_at || new Date().toISOString()),
      billTo: {
        companyName: request.company_name ? String(request.company_name) : null,
        vatNumber: request.vat_number ? String(request.vat_number) : null,
        email: String(request.email),
        metadata:
          request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
            ? (request.metadata as Record<string, unknown>)
            : {},
      },
      lineItems,
      subtotal,
      vatAmount,
      total,
      currency,
    })

    const storagePath = `invoices/${request.restaurant_id}/${trimmedId}.pdf`

    if (process.env.INVOICE_SKIP_STORAGE !== 'true') {
      const { error: uploadError } = await supabase.storage.from(INVOICE_BUCKET).upload(storagePath, pdfBytes, {
        upsert: true,
        contentType: 'application/pdf',
        cacheControl: '3600',
      })

      if (uploadError) throw new Error(uploadError.message || 'Failed to upload invoice PDF')
    } else {
      console.info('[invoices] skip storage upload (test mode)', { storagePath, bytes: pdfBytes.length })
    }

    const now = new Date().toISOString()
    await supabase
      .from('invoice_requests')
      .update({
        status: 'sent',
        pdf_url: storagePath,
        generated_at: now,
        sent_at: now,
        failure_reason: null,
        retry_count: attempt,
      })
      .eq('id', trimmedId)

    await emitInvoiceGenerated({
      event_id: randomUUID(),
      event_type: 'invoice.generated',
      occurred_at: now,
      restaurant_id: String(request.restaurant_id),
      order_id: String(request.order_id),
      invoice_request_id: trimmedId,
      invoice_number: invoiceNumber,
      email: String(request.email),
      status: 'sent',
      pdf_storage_path: storagePath,
      restaurant_name: String(restaurant.name),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invoice generation failed'
    await markFailed(supabase, trimmedId, retryCount, message, notifyContext)
    throw error
  }
}
