/**
 * Item-level bill splitting -- application-layer helpers over
 * supabase/migrations/20260829170000_order_line_allocations.sql.
 *
 * Depends on order_lines existing for this order, which (see app/api/terminal/rounds/route.ts)
 * only happens when the restaurant has station_screens_enabled -- the same reason
 * app/api/terminal/tabs/[tabId]/amend/route.ts gates on that same flag. This is not a new
 * restriction invented for this feature; it is the existing one, inherited.
 */
import { splitCentsByWeight, toCents, type CentsSplitShare } from '@/lib/billing/split-cents'

export type SupabaseLike = { from: (table: string) => any; rpc: (fn: string, args: unknown) => any }

export type AllocationShareInput = {
  allocated_to: string
  quantity_allocated: number
}

export type BuiltAllocation = {
  restaurant_id: string
  order_id: string
  order_line_id: string
  tab_id: string | null
  allocated_to: string
  quantity_allocated: number
  amount_cents: number
  created_by_actor_kind: 'terminal' | 'system'
  created_by_actor_user_id: string | null
}

/**
 * Read the money figure for one order_line: orders.items[source_item_index].total, in integer
 * cents. order_lines itself carries no price column by design (see that table's own migration
 * header) -- this is the one join back to money the whole feature relies on.
 */
export async function readLineTotalCents(
  supabase: SupabaseLike,
  params: { orderLineId: string; restaurantId: string },
): Promise<{ orderId: string; tabId: string | null; totalCents: number } | null> {
  const { data: line, error: lineError } = await supabase
    .from('order_lines')
    .select('id, order_id, tab_id, source_item_index, kitchen_state, bar_state')
    .eq('id', params.orderLineId)
    .eq('restaurant_id', params.restaurantId)
    .maybeSingle()

  if (lineError || !line) return null

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, items')
    .eq('id', line.order_id)
    .maybeSingle()

  if (orderError || !order) return null

  const items = Array.isArray(order.items) ? order.items : []
  const item = items[line.source_item_index] as { total?: unknown } | undefined
  if (!item || item.total === undefined || item.total === null) return null

  const totalCents = toCents(Number(item.total))
  if (!Number.isFinite(totalCents) || totalCents < 0) return null

  return { orderId: String(line.order_id), tabId: line.tab_id ? String(line.tab_id) : null, totalCents }
}

/**
 * Build (but do not insert) the allocation rows for one line, splitting its total EXACTLY across
 * `shares` by quantity_allocated weight. Throws (via splitCentsByWeight) rather than silently
 * producing a set of rows whose amounts do not sum to the line's own total.
 */
export function buildAllocationsForLine(params: {
  restaurantId: string
  orderId: string
  orderLineId: string
  tabId: string | null
  lineTotalCents: number
  shares: AllocationShareInput[]
  actorKind: 'terminal' | 'system'
  actorUserId: string | null
}): BuiltAllocation[] {
  const centsShares: CentsSplitShare[] = params.shares.map((s, i) => ({
    key: String(i),
    weight: s.quantity_allocated,
  }))

  const split = splitCentsByWeight(params.lineTotalCents, centsShares)

  return params.shares.map((share, i) => ({
    restaurant_id: params.restaurantId,
    order_id: params.orderId,
    order_line_id: params.orderLineId,
    tab_id: params.tabId,
    allocated_to: share.allocated_to,
    quantity_allocated: share.quantity_allocated,
    amount_cents: split[i].amountCents,
    created_by_actor_kind: params.actorKind,
    created_by_actor_user_id: params.actorUserId,
  }))
}
