import type { createServerSupabaseClient } from '@/lib/supabase/server'

const TEN_MIN_MS = 10 * 60 * 1000

/**
 * Cancels abandoned hosted (customer phone/QR pay link) orders older than 10 minutes
 * that are still payment_status='pending', then closes any tabs left with no active orders.
 * Extracted from app/api/orders/expire-pending so the Cloudflare cron can reuse it.
 */
export async function expireHostedPendingOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
): Promise<{ expiredCount: number; closedTabCount: number }> {
  const tenMinutesAgo = new Date(Date.now() - TEN_MIN_MS).toISOString()

  const { data: expiredOrders, error } = await supabase
    .from('orders')
    .update({
      payment_status: 'cancelled',
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: 'hosted_timeout',
    })
    .eq('payment_status', 'pending')
    .eq('payment_channel', 'hosted')
    .lt('placed_at', tenMinutesAgo)
    .select('id, restaurant_id, table_number, tab_id')

  if (error) throw error

  const rows = expiredOrders || []
  const nowIso = new Date().toISOString()
  const seenTabs = new Set<string>()
  let closedTabCount = 0

  for (const order of rows) {
    const tabId = order.tab_id ? String(order.tab_id).trim() : ''
    if (!tabId || seenTabs.has(tabId)) continue
    seenTabs.add(tabId)

    const { data: activeOrders } = await supabase
      .from('orders')
      .select('id')
      .eq('tab_id', tabId)
      .neq('status', 'cancelled')

    if (!activeOrders || activeOrders.length === 0) {
      const { error: tabErr } = await supabase
        .from('tabs')
        .update({
          status: 'closed',
          closed_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', tabId)

      if (tabErr) {
        console.warn('[EXPIRE-HOSTED] Tab close failed:', tabId, tabErr)
      } else {
        closedTabCount += 1
        console.log('[EXPIRE-HOSTED] Closed abandoned tab:', tabId)
      }
    }
  }

  return { expiredCount: rows.length, closedTabCount }
}
