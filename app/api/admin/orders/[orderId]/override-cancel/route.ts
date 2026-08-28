/**
 * POST /api/admin/orders/{orderId}/override-cancel
 *
 * The per-order manual override on a held card: a human overruling the E04111 persistence rule for
 * ONE order. The decision, the re-query and the audit trail are in `lib/orders/override-cancel.ts`;
 * this file is the gate and the scope.
 *
 * ONE ORDER ID, IN THE PATH, AND NO RESTAURANT ID IN THE BODY.
 *
 * The order id is here because that is the whole point -- this is deliberately not a blanket clear,
 * and each press is a decision about one order and one amount. It is still re-read server-side and
 * re-queried against the gateway before anything is written, so naming an order buys the caller
 * nothing except which order they are deciding about.
 *
 * The restaurant is resolved server-side from the session's active venue, exactly as the clear-all
 * does, so a caller cannot name someone else's order and the permission is checked against the same
 * id as the blast radius.
 *
 * BEHIND `orders:update`, matching the clear-all. Not a new permission: a new one defaults to
 * nobody holding it, which ships the button invisible and reads as the feature not working.
 *
 * A REFUSAL IS 200, NOT AN ERROR. "The provider now says this is PAID, so I did not cancel it" is
 * the system working, and it is the single most important thing this endpoint can say. Returning it
 * as a 4xx would let a client render it as a generic failure and lose the sentence that matters.
 * Only auth, permission, a bad id and a genuine fault get a non-2xx.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { overrideCancelHeldOrder } from '@/lib/orders/override-cancel'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  let user: Awaited<ReturnType<typeof getUserFromRequest>>
  try {
    user = await getUserFromRequest(request)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sign in again.'
    return NextResponse.json({ error: message }, { status: 401 })
  }

  try {
    const { orderId } = await params
    if (!orderId || !isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.ORDERS_UPDATE)
    if (denied) return denied

    const result = await overrideCancelHeldOrder(supabase, {
      restaurantId,
      orderId,
      requestedBy: user.id,
    })

    // Both shapes are 200. `ok` carries the outcome; see the header.
    return NextResponse.json({ success: true, result })
  } catch (err: unknown) {
    /**
     * Reached only when the order could not be read or the write itself faulted. The message is
     * deliberately not passed to the client -- it is a database error string, not staff-facing
     * copy, and the card has its own signed line for a request that did not run.
     */
    console.error('[orders/override-cancel]', err)
    return NextResponse.json({ error: 'The override could not be completed.' }, { status: 500 })
  }
}
