import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { InvoiceRequestError, requestInvoice } from '@/lib/invoices/request-invoice'
import { PERMISSIONS } from '@/lib/permissions'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const trimmedOrderId = String(orderId || '').trim()

  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { data: existingOrder, error: loadError } = await supabase
    .from('orders')
    .select('id, restaurant_id')
    .eq('id', trimmedOrderId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }

  if (!existingOrder?.restaurant_id) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(
    String(existingOrder.restaurant_id),
    PERMISSIONS.ORDERS_READ,
    req,
  )
  if (isAuthError(auth)) return auth

  const body = await req.json().catch(() => null)

  try {
    const result = await requestInvoice(auth.supabase, {
      orderId: trimmedOrderId,
      paymentId: body?.payment_id ?? body?.paymentId ?? null,
      source: 'staff',
      idempotencyKey: `invoice:staff:${trimmedOrderId}`,
      details: {
        email: body?.email,
        company_name: body?.company_name ?? body?.companyName,
        vat_number: body?.vat_number ?? body?.vatNumber,
        metadata: body?.metadata,
      },
    })

    return NextResponse.json({
      success: true,
      invoice_request_id: result.invoiceRequestId,
      status: result.status,
      source: result.source,
      created: result.created,
      is_resend: result.isResend,
      invoice_number: result.invoiceNumber,
    })
  } catch (error) {
    if (error instanceof InvoiceRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }

    const message = error instanceof Error ? error.message : 'Failed to request invoice'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
