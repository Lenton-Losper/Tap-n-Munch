import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type MarkPaymentAttemptStartedParams = {
  orderId: string
  restaurantId: string
  businessOrderNo: string
  source: 'terminal_app' | 'staff_push'
  terminalId?: string | null
  terminalSn?: string | null
  appVersion?: string | null
  launchedAt?: string | null
  extraAuditMetadata?: Record<string, unknown>
}

export type MarkPaymentAttemptStartedResult = {
  recorded: boolean
  startedAt: string
}

/**
 * Durable marker that a real payment attempt actually started, distinct from merely
 * allocating orders.paycloud_merchant_order_no. Idempotent: the earliest marker wins.
 */
export async function markPaymentAttemptStarted(
  supabase: Supabase,
  params: MarkPaymentAttemptStartedParams,
): Promise<MarkPaymentAttemptStartedResult> {
  const startedAt = params.launchedAt && String(params.launchedAt).trim()
    ? String(params.launchedAt).trim()
    : new Date().toISOString()

  const { data: existingAudit, error: existingAuditError } = await supabase
    .from('audit_logs')
    .select('metadata')
    .eq('restaurant_id', params.restaurantId)
    .eq('entity_type', 'order')
    .eq('entity_id', params.orderId)
    .eq('action', 'payment.attempt_started')
    .maybeSingle()
  if (existingAuditError) throw existingAuditError
  if (existingAudit) {
    const existingStartedAt = String(
      (existingAudit.metadata as { launchedAt?: unknown } | null)?.launchedAt || startedAt,
    )
    return {
      recorded: false,
      startedAt: existingStartedAt,
    }
  }

  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: params.restaurantId,
    action: 'payment.attempt_started',
    entity_type: 'order',
    entity_id: params.orderId,
    metadata: {
      businessOrderNo: params.businessOrderNo,
      source: params.source,
      terminalId: params.terminalId ?? null,
      terminalSn: params.terminalSn ?? null,
      appVersion: params.appVersion ?? null,
      launchedAt: startedAt,
      ...params.extraAuditMetadata,
    },
  })
  if (auditError) throw auditError

  // Best-effort denormalized columns for future direct reads. This path is optional so
  // staging/prod can adopt the audit marker first even before the migration lands.
  const { error: updateError } = await supabase
      .from('orders')
      .update({
        payment_attempt_started_at: startedAt,
        payment_attempt_source: params.source,
        ...(params.terminalSn ? { terminal_sn: params.terminalSn } : {}),
      })
      .eq('id', params.orderId)
      .eq('restaurant_id', params.restaurantId)
  if (updateError && !String(updateError.message || '').includes('payment_attempt_started_at')) {
    console.error('[markPaymentAttemptStarted] order marker update failed:', updateError)
  }

  return {
    recorded: true,
    startedAt,
  }
}
