import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { ORDER_CANCELLED_ACTION } from '@/lib/orders/cancel-order-with-trail'

const TEN_MIN_MS = 10 * 60 * 1000

/**
 * Cancels abandoned hosted (customer phone/QR pay link) orders older than 10 minutes that are still
 * payment_status='pending', then closes any tabs left with no active orders.
 *
 * ============================================================================================
 * #329 — THIS PATH CHANGED A MONEY STATUS AND LEFT NO ROW IN audit_logs
 * ============================================================================================
 *
 * #329 asks whether an order can reach `cancelled` with no evidence of who did it. Every other
 * writer answers no: the dashboard route, handleTerminalPaymentFailed, autoCancelStalePosOrders and
 * cancelOrderWithTrail all write `order.cancelled`. This one did not. It set `cancelled_at` and
 * `cancellation_reason` on the row, which is a partial trail, but a search of audit_logs — the thing
 * anyone actually queries when asking "what happened to this order" — returned nothing.
 *
 * That is the whole point of ORDER_CANCELLED_ACTION: one action for every cancel path, so the
 * question is one query rather than knowing which of five writers to ask.
 *
 * Written per order rather than through cancelOrderWithTrail because the UPDATE here is a single
 * bulk statement whose `payment_status='pending'` predicate IS the race guard — turning it into N
 * individual claims to reuse the helper would trade a correct atomic filter for a loop.
 *
 * ============================================================================================
 * AND THE TAB CLOSE NEVER WORKED. NOT ONCE.
 * ============================================================================================
 *
 * The close patched `closed_at` and `updated_at`. NEITHER COLUMN EXISTS on `tabs` — verified
 * against staging 2026-08-24:
 *
 *     tabs.closed_at    MISSING (column tabs.closed_at does not exist)
 *     tabs.updated_at   MISSING (column tabs.updated_at does not exist)
 *     the UPDATE shape  REJECTED — Could not find the 'closed_at' column of 'tabs'
 *
 * PostgREST rejects the ENTIRE patch when one column is unknown, so no tab was ever closed by this
 * function. The failure was swallowed by a `console.warn`, `closedTabCount` stayed 0, and the cron
 * reported success — the same shape as the dead `lib/table-session.ts` patch.
 *
 * Consequence: every abandoned hosted tab stayed `open` indefinitely, holding
 * `idx_tabs_one_open_per_table` and its table. That is a contributor to the backlog #333 is about.
 *
 * The fix writes only `status`, which exists and which `isTabSessionEndedStatus` already treats as
 * ended. It deliberately does NOT write `settled_at`/`settled_type`: nothing was collected here —
 * every order on the tab is cancelled — and those fields mean a settlement happened.
 */
export async function expireHostedPendingOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
): Promise<{ expiredCount: number; closedTabCount: number; auditFailureCount: number }> {
  const tenMinutesAgo = new Date(Date.now() - TEN_MIN_MS).toISOString()
  const cancelledAt = new Date().toISOString()

  const { data: expiredOrders, error } = await supabase
    .from('orders')
    .update({
      payment_status: 'cancelled',
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancellation_reason: 'hosted_timeout',
    })
    .eq('payment_status', 'pending')
    .eq('payment_channel', 'hosted')
    .lt('placed_at', tenMinutesAgo)
    .select('id, restaurant_id, table_number, tab_id, total, paycloud_merchant_order_no')

  if (error) throw error

  const rows = expiredOrders || []
  let auditFailureCount = 0

  if (rows.length > 0) {
    const { error: auditError } = await supabase.from('audit_logs').insert(
      rows.map((order) => ({
        restaurant_id: order.restaurant_id,
        entity_type: 'order',
        entity_id: String(order.id),
        action: ORDER_CANCELLED_ACTION,
        metadata: {
          source: 'expire_hosted_pending_orders',
          basis: 'hosted_checkout_abandoned',
          basisNote:
            'A hosted checkout was opened and left unpaid for more than 10 minutes. No gateway ' +
            'confirmation was ever received, so no charge is recorded against this order. If the ' +
            'customer did in fact pay, the webhook or the reconcile path is where that shows up.',
          cancellationReason: 'hosted_timeout',
          cancelledAt,
          orderTotal: order.total ?? null,
          businessOrderNo: order.paycloud_merchant_order_no ?? null,
          tableNumber: order.table_number ?? null,
        },
      })),
    )
    // Best effort, and COUNTED. The orders are already cancelled; throwing here would report a
    // failure for work that happened. Returning the number means a silent trail gap shows up in the
    // cron's own output instead of only in a log line nobody greps.
    if (auditError) {
      auditFailureCount = rows.length
      console.error('[EXPIRE-HOSTED] audit rows failed for', rows.length, 'order(s):', auditError.message)
    }
  }

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
        .update({ status: 'closed' })
        .eq('id', tabId)

      if (tabErr) {
        console.warn('[EXPIRE-HOSTED] Tab close failed:', tabId, tabErr)
      } else {
        closedTabCount += 1
        console.log('[EXPIRE-HOSTED] Closed abandoned tab:', tabId)
      }
    }
  }

  return { expiredCount: rows.length, closedTabCount, auditFailureCount }
}
