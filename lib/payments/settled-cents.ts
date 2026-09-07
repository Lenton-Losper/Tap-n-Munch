/**
 * HOW MUCH OF EACH ORDER HAS ALREADY BEEN COLLECTED THROUGH THE ITEM LEDGER.
 *
 * ==================================================================================================
 * WHY A WHOLE-ORDER CHARGE HAS TO ASK THIS
 * ==================================================================================================
 *
 * Settlement stopped being order-grained the moment items could be paid for individually, but the
 * whole-order charge basis did not follow. prepare-payment summed `orders.total` and the settle
 * route summed the same figure, neither of them aware that part of the order might already be in
 * the till.
 *
 * Order #45 at Digi Cofee is the shape: N$37.00 total, N$17.00 already settled through two
 * allocations, N$20.00 genuinely owed. Reaching for "Settle Entire Tab" would have asked the
 * reader for the full N$37.00 and taken the same N$17.00 twice.
 *
 * The tab header already tells the waiter N$20.00 -- outstandingCentsFor has subtracted the
 * settled part since it was written. This is the same arithmetic on the charge path, so the figure
 * a customer is quoted and the figure their card is asked for cannot disagree.
 *
 * ==================================================================================================
 * IT FAILS CLOSED, AND THAT IS THE WHOLE POINT
 * ==================================================================================================
 *
 * A failed read does NOT fall back to the order total. Not being able to see what has already been
 * collected is not permission to collect it again -- the same rule allocationIdsHeldByLiveCard
 * follows, and for the same reason: on the money path, the failure that charges twice must be
 * louder than the failure that charges nothing.
 *
 * Callers surface that as a refusal. A waiter retrying is recoverable; a customer charged twice is
 * a chargeback and a conversation at the table.
 *
 * ==================================================================================================
 * VOIDED ALLOCATIONS ARE EXCLUDED, SETTLED ONES ARE THE POINT
 * ==================================================================================================
 *
 * A voided allocation was withdrawn before anyone paid for it, so it owes nothing and has settled
 * nothing. A settled one is money in the till and must reduce what is still chargeable.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export class SettledCentsUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettledCentsUnreadable'
  }
}

/**
 * Cents already settled per order id, through order_line_allocation_settlements.
 *
 * Orders with no allocations at all -- the ordinary case, and every order that predates splitting
 * -- are simply absent from the map, which callers read as zero. That is what keeps this change
 * inert for the payments that make up almost all of production.
 *
 * Two plain `.in()` queries rather than one nested select: `.in()` is parser-free (the #242/#254
 * shape), and the join through allocations is a map lookup we can do in memory over a handful of
 * rows.
 */
export async function settledCentsByOrder(
  supabase: Supabase,
  orderIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = [...new Set((orderIds ?? []).map((id) => String(id)).filter(Boolean))]
  if (ids.length === 0) return out

  const { data: allocations, error: allocError } = await supabase
    .from('order_line_allocations')
    .select('id, order_id')
    .in('order_id', ids)
    .is('voided_at', null)

  if (allocError) {
    throw new SettledCentsUnreadable(`could not read allocations: ${allocError.message}`)
  }

  const orderByAllocation = new Map<string, string>()
  for (const row of allocations ?? []) {
    orderByAllocation.set(String((row as { id: unknown }).id), String((row as { order_id: unknown }).order_id))
  }
  // No allocations means nothing has been settled item by item. Not a failure.
  if (orderByAllocation.size === 0) return out

  const { data: settlements, error: settleError } = await supabase
    .from('order_line_allocation_settlements')
    .select('order_line_allocation_id, amount_cents')
    .in('order_line_allocation_id', [...orderByAllocation.keys()])

  if (settleError) {
    throw new SettledCentsUnreadable(`could not read settlements: ${settleError.message}`)
  }

  for (const row of settlements ?? []) {
    const allocationId = String((row as { order_line_allocation_id: unknown }).order_line_allocation_id)
    const orderId = orderByAllocation.get(allocationId)
    if (!orderId) continue
    const raw = Number((row as { amount_cents: unknown }).amount_cents)
    // A row we cannot read the amount of is skipped rather than counted as zero silently: it would
    // otherwise inflate what is still chargeable, which is the direction that charges twice.
    if (!Number.isFinite(raw)) {
      throw new SettledCentsUnreadable(`settlement ${allocationId} has an unreadable amount`)
    }
    out.set(orderId, (out.get(orderId) ?? 0) + Math.max(0, Math.round(raw)))
  }

  return out
}

/**
 * What is still chargeable on one order, in cents.
 *
 * Clamped at zero PER ORDER. Clamping only on a sum would let one over-settled order silently
 * absorb another's genuine debt, and the tab would be charged less than it is owed -- the same
 * reasoning as outstandingCentsFor, which this deliberately mirrors.
 */
export function chargeableCentsFor(total: unknown, settledCents: number | undefined): number {
  const asNumber = Number(total)
  const totalCents = Number.isFinite(asNumber) ? Math.round(asNumber * 100) : 0
  const settled = Number.isFinite(Number(settledCents)) ? Math.max(0, Math.round(Number(settledCents))) : 0
  return Math.max(0, totalCents - settled)
}
