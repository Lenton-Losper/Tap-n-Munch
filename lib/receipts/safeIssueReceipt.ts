import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * Issues a SALE_RECEIPT after an order is paid. Never throws — payment/settlement
 * responses must not fail because receipt issuance failed (card may already be captured).
 * Idempotent: issueReceiptForOrder uses the unique (order_id, document_type, version) constraint.
 * On failure, writes audit_logs so support can reconstruct issuance misses.
 */
export async function safeIssueReceiptForOrder(
  orderId: string,
  context: string,
): Promise<void> {
  try {
    await issueReceiptForOrder(orderId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[${context}] receipt issuance failed for order ${orderId}:`, error)

    try {
      const supabase = createServerSupabaseClient()
      const { data: order } = await supabase
        .from('orders')
        .select('restaurant_id')
        .eq('id', orderId)
        .maybeSingle()

      if (order?.restaurant_id) {
        await supabase.from('audit_logs').insert({
          restaurant_id: order.restaurant_id,
          action: 'receipt.issuance_failed',
          entity_type: 'order',
          entity_id: orderId,
          metadata: {
            context,
            error: message,
          },
        })
      }
    } catch (auditError) {
      console.error(`[${context}] failed to audit receipt issuance failure:`, auditError)
    }
  }
}

export async function safeIssueReceiptsForOrders(
  orderIds: string[],
  context: string,
): Promise<void> {
  const uniqueIds = [...new Set(orderIds.map((id) => String(id).trim()).filter(Boolean))]
  await Promise.all(uniqueIds.map((id) => safeIssueReceiptForOrder(id, context)))
}
