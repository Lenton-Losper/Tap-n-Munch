import type { createServerSupabaseClient } from '@/lib/supabase/server'

export const STALE_POS_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Cancels Sale-tab/terminal POS orders that were created but never pushed to a terminal
 * (payment_status still 'pending') and have sat longer than the timeout. Deliberately scoped to
 * channel='pos' only -- other channels (table/kiosk/online) can legitimately sit at
 * payment_status='pending' for a long time (e.g. pay-at-till), so a blanket payment_status
 * filter would wrongly cancel those too.
 *
 * The UPDATE re-checks payment_status='pending' in its WHERE clause, so a concurrent
 * push-to-terminal (which flips payment_status to 'terminal_pending' first) naturally wins
 * the race and this becomes a no-op for that row. terminal_pending orders are never touched
 * here, on purpose -- cancelling something already mid-flight with Finatic needs to check
 * with Finatic first, not just time out (deferred).
 *
 * Pass restaurantId for check-on-read (terminal GET); omit for the Cloudflare cron backstop.
 */
export async function autoCancelStalePosOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId?: string,
): Promise<{ cancelledCount: number; cancelledIds: string[] }> {
  const cutoffIso = new Date(Date.now() - STALE_POS_TIMEOUT_MS).toISOString()

  let query = supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: 'auto_timeout',
    })
    .eq('channel', 'pos')
    .eq('payment_status', 'pending')
    .lt('placed_at', cutoffIso)

  if (restaurantId) {
    query = query.eq('restaurant_id', restaurantId)
  }

  const { data, error } = await query.select('id')
  if (error) throw error

  const cancelledIds = (data ?? []).map((row) => String(row.id))
  return { cancelledCount: cancelledIds.length, cancelledIds }
}
