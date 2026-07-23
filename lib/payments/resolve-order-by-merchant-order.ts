import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * Resolve order ids for a Finatic merchant_order_no.
 * 1) orders.paycloud_merchant_order_no OR orders.payment_reference (primary)
 * 2) payment_events.business_order_no → order_ids (fallback for older POS rows)
 */
export async function resolveOrderIdsByMerchantOrderNo(
  supabase: Supabase,
  merchantOrderNo: string,
): Promise<{ orderIds: string[]; source: 'orders' | 'payment_events' | null }> {
  const mo = merchantOrderNo.trim()
  if (!mo) return { orderIds: [], source: null }

  const { data: orderRows, error: orderError } = await supabase
    .from('orders')
    .select('id')
    .or(`paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`)

  if (orderError) {
    throw new Error(`resolveOrderIdsByMerchantOrderNo orders: ${orderError.message}`)
  }

  if (orderRows?.length) {
    return {
      orderIds: orderRows.map((row) => String(row.id)),
      source: 'orders',
    }
  }

  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('order_ids')
    .eq('business_order_no', mo)
    .eq('event_type', 'sale')
    .limit(5)

  if (eventsError) {
    throw new Error(`resolveOrderIdsByMerchantOrderNo payment_events: ${eventsError.message}`)
  }

  const ids = new Set<string>()
  for (const event of events ?? []) {
    const raw = event.order_ids
    if (!Array.isArray(raw)) continue
    for (const id of raw) {
      const s = String(id || '').trim()
      if (s) ids.add(s)
    }
  }

  if (ids.size === 0) return { orderIds: [], source: null }
  return { orderIds: [...ids], source: 'payment_events' }
}
