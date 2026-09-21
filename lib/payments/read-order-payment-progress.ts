/**
 * READ the per-line settlement facts a page needs to show partial payment, and reduce them.
 *
 * ==================================================================================================
 * READ ONLY, AND IT MUST NOT BE ABLE TO BREAK A PAGE
 * ==================================================================================================
 *
 * This is the display counterpart to `settledCentsByOrder`, and it differs from it in exactly one
 * way that matters: THAT one fails closed and throws, because its answer decides what a card is
 * asked for, and not knowing what has been collected is not permission to collect it again. THIS
 * one degrades, because its answer only decides a label, and taking Order History down to avoid
 * mislabelling a badge is a worse trade.
 *
 * The degradation is to say NOTHING rather than to guess. A failed read yields no entry for the
 * order, and the caller renders whatever it rendered before this existed. It never yields
 * "UNPAID, N$34 remaining" for an order that is in fact part-paid -- a confident wrong figure is
 * the one failure this feature exists to remove.
 *
 * ==================================================================================================
 * WHERE A LINE'S MONEY COMES FROM
 * ==================================================================================================
 *
 * `order_lines` has no amount column. A line's own money is `orders.items[source_item_index].total`,
 * which is what `readLineTotalCents` (lib/orders/order-line-allocations.ts) reads and what the
 * allocation builder splits. The same index is used here so a line is priced the same way on the
 * bill, on the terminal and in history.
 *
 * Two flat `.in()` queries and a join in memory, rather than a nested select: `.in()` is
 * parser-free -- the #242/#254 shape -- and the joins are over a page of orders.
 */
import {
  orderPaymentProgress,
  type OrderPaymentProgress,
  type ProgressLine,
} from '@/lib/payments/order-payment-progress'
import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** Just enough of an order to price its lines and know its own verdict. */
export type ProgressOrderInput = {
  id: string
  total: unknown
  payment_status: unknown
  items: unknown
}

const itemTotalCents = (items: unknown, index: unknown): number | null => {
  if (!Array.isArray(items)) return null
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= items.length) return null
  const raw = (items[i] as { total?: unknown } | undefined)?.total
  if (raw === undefined || raw === null) return null
  const cents = Math.round(Number(raw) * 100)
  return Number.isFinite(cents) && cents >= 0 ? cents : null
}

/**
 * Progress per order id. Orders whose lines could not be read are ABSENT from the map, which the
 * caller must read as "no breakdown available", never as "nothing paid".
 */
export async function readOrderPaymentProgress(
  supabase: Supabase,
  orders: readonly ProgressOrderInput[],
): Promise<Map<string, OrderPaymentProgress>> {
  const out = new Map<string, OrderPaymentProgress>()
  const ids = [...new Set((orders ?? []).map((o) => String(o?.id ?? '')).filter(Boolean))]
  if (ids.length === 0) return out

  const { data: lines, error: lineError } = await supabase
    .from('order_lines')
    .select('id, order_id, source_item_index')
    .in('order_id', ids)

  if (lineError) {
    console.error('[order-payment-progress] lines unavailable', lineError.message)
    return out
  }

  const lineRows = (lines ?? []) as Array<{ id: unknown; order_id: unknown; source_item_index: unknown }>

  /**
   * VOIDED ALLOCATIONS ARE EXCLUDED. A voided allocation was withdrawn before anyone paid for it,
   * so it has settled nothing -- the same exclusion `settledCentsByOrder` makes, for the same
   * reason. Counting one would show money collected that never was.
   */
  const lineIds = lineRows.map((r) => String(r.id)).filter(Boolean)
  const settledByLine = new Map<string, number>()
  if (lineIds.length > 0) {
    const { data: allocations, error: allocError } = await supabase
      .from('order_line_allocations')
      .select('order_line_id, amount_cents, settled_at')
      .in('order_line_id', lineIds)
      .is('voided_at', null)

    if (allocError) {
      console.error('[order-payment-progress] allocations unavailable', allocError.message)
      return out
    }

    for (const a of (allocations ?? []) as Array<Record<string, unknown>>) {
      if (a.settled_at == null) continue
      const key = String(a.order_line_id)
      const cents = Number(a.amount_cents)
      if (!Number.isFinite(cents)) continue
      settledByLine.set(key, (settledByLine.get(key) ?? 0) + Math.max(0, Math.round(cents)))
    }
  }

  const linesByOrder = new Map<string, Array<{ id: string; index: unknown }>>()
  for (const row of lineRows) {
    const orderId = String(row.order_id)
    const list = linesByOrder.get(orderId) ?? []
    list.push({ id: String(row.id), index: row.source_item_index })
    linesByOrder.set(orderId, list)
  }

  for (const order of orders ?? []) {
    const orderId = String(order?.id ?? '')
    if (!orderId) continue
    const own = linesByOrder.get(orderId) ?? []
    const progressLines: ProgressLine[] = own.map((line) => ({
      totalCents: itemTotalCents(order.items, line.index),
      settledCents: settledByLine.get(line.id) ?? 0,
    }))
    out.set(
      orderId,
      orderPaymentProgress({
        orderTotal: order.total,
        paymentStatus: order.payment_status,
        lines: progressLines,
      }),
    )
  }

  return out
}
