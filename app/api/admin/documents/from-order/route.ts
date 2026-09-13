import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import {
  createInvoiceFromOrder,
  type InvoiceFromOrderRefusalCode,
} from '@/lib/documents/create-invoice-from-order'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/documents/from-order — raise a FORMAL INVOICE from an existing FlashTap order.
 *
 * ================================================================================================
 * THIS ENDPOINT MOVES NO MONEY
 * ================================================================================================
 *
 * It creates one `business_documents` row. It does not call a gateway, does not create or reuse a
 * payment intent, does not mint a merchant order number, does not settle anything, and does not
 * write `orders.payment_status` or `orders.status`. An unpaid order is exactly as unpaid after a
 * successful call as it was before.
 *
 * It is deliberately NOT mounted under the payment routes and shares no helper with them.
 *
 * ================================================================================================
 * WHAT THE CLIENT MAY SEND
 * ================================================================================================
 *
 *   order_id        which order to bill for
 *   restaurant_id   whose venue — checked against the caller's memberships, never trusted
 *   bill_to         who the invoice is addressed to (free text, see below)
 *   due_date        optional
 *   reference_note  optional
 *
 * It may NOT send line items, quantities, prices, VAT, a total, or a payment status. Every figure
 * on the document is read from the order row by the server.
 *
 * ================================================================================================
 * bill_to IS NOT PERSISTED TO THE ORDER
 * ================================================================================================
 *
 * FlashTap stores no customer email or phone, on `orders` or anywhere else, and this endpoint does
 * not begin storing them. `bill_to` is snapshotted onto THIS document — which is what a document
 * is, a frozen record — and is not written back to the order, the customer, or any profile.
 *
 * Whether FlashTap should hold customer contact details at all is a privacy and product decision
 * that has not been taken (there is a recorded customer-email purge in this repository's history).
 * Until it is, an invoice can carry a bill-to party typed by staff at the moment of issue, and no
 * new customer record comes into existence.
 */

const REFUSAL_STATUS: Record<InvoiceFromOrderRefusalCode, number> = {
  ORDER_NOT_FOUND: 404,
  ORDER_CANCELLED: 409,
  ORDER_NOT_FINAL: 409,
  ORDER_AWAITING_REACCEPTANCE: 409,
  ORDER_REFUNDED: 409,
  ORDER_HAS_NO_LINES: 409,
  ORDER_TOTAL_UNUSABLE: 409,
  // Not a client error in the ordinary sense: the request was well formed and the venue is not
  // configured. 409 so the UI can route it to "finish setting up Settings -> Billing".
  BILLING_PROFILE_INCOMPLETE: 409,
  INVOICE_ALREADY_EXISTS: 409,
  DOCUMENT_TOTAL_DISAGREES_WITH_ORDER: 409,
}

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function trimParty(party: unknown): Record<string, unknown> {
  if (!party || typeof party !== 'object' || Array.isArray(party)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(party as Record<string, unknown>)) {
    out[key] = typeof value === 'string' ? value.trim() : value
  }
  return out
}

export async function POST(request: Request) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      order_id?: unknown
      restaurant_id?: unknown
      bill_to?: unknown
      due_date?: unknown
      reference_note?: unknown
    }

    const orderId = String(body.order_id ?? '').trim()
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'order_id must be a valid UUID' }, { status: 400 })
    }

    const requestedRestaurantId = String(body.restaurant_id ?? '').trim()
    if (!requestedRestaurantId) {
      return NextResponse.json({ error: 'restaurant_id is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()

    /**
     * AUTHORIZATION RESOLVES THE RESTAURANT. The value below is the one every later read is scoped
     * to; the client's string is only ever an input to this check, never a filter in its own right.
     */
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, requestedRestaurantId)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    const result = await createInvoiceFromOrder(supabase, {
      orderId,
      restaurantId,
      createdBy: user.id,
      billTo: trimParty(body.bill_to),
      dueDate: typeof body.due_date === 'string' && body.due_date.trim() ? body.due_date.trim() : null,
      referenceNote:
        typeof body.reference_note === 'string' && body.reference_note.trim()
          ? body.reference_note.trim()
          : null,
    })

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          code: result.code,
          missingBillingFields: result.missingBillingFields,
          existingDocument: result.existingDocument,
        },
        { status: REFUSAL_STATUS[result.code] ?? 409 },
      )
    }

    return NextResponse.json(
      { document: result.document, warnings: result.warnings },
      { status: 201 },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create invoice'
    console.error('[documents/from-order] failed', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
