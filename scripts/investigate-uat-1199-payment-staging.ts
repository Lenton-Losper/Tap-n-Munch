/**
 * Read-only: look up the Finatic-UAT staging APK decline (~NAD 11.99 around 14:18 UTC /
 * 16:18 CAT on 2026-07-28) and dump raw order + audit_logs (+ payment_events) rows.
 *
 * Trigger: commit message contains [investigate-uat-1199]
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF)) {
  throw new Error(`Refusing: expected staging URL containing ${STAGING_REF}, got ${url}`)
}
if (!key) throw new Error('Missing staging SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function log(label: string, value: unknown) {
  console.log(`\n===== ${label} =====`)
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  // 4:18 PM CAT = 14:18 UTC. Search a generous window around that minute.
  const windowStart = '2026-07-28T13:50:00.000Z'
  const windowEnd = '2026-07-28T14:50:00.000Z'
  const targetTotal = 11.99

  const { data: byPlaced, error: byPlacedErr } = await admin
    .from('orders')
    .select('*')
    .gte('placed_at', windowStart)
    .lte('placed_at', windowEnd)
    .order('placed_at', { ascending: true })
  if (byPlacedErr) throw byPlacedErr

  const { data: byCreated, error: byCreatedErr } = await admin
    .from('orders')
    .select('*')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
  if (byCreatedErr) throw byCreatedErr

  const byId = new Map<string, Record<string, unknown>>()
  for (const row of [...(byPlaced ?? []), ...(byCreated ?? [])]) {
    byId.set(String(row.id), row as Record<string, unknown>)
  }

  const amountMatches = [...byId.values()].filter((row) => {
    const total = Number(row.total)
    return Number.isFinite(total) && Math.abs(total - targetTotal) < 0.005
  })

  log('lookup_params', {
    windowStart,
    windowEnd,
    targetTotal,
    ordersInWindow: byId.size,
    amountMatches: amountMatches.length,
  })

  // Fallback: any 11.99 today if the tight window missed (device clock skew).
  let targets = amountMatches
  if (targets.length === 0) {
    const dayStart = '2026-07-28T00:00:00.000Z'
    const dayEnd = '2026-07-28T23:59:59.999Z'
    const { data: dayRows, error: dayErr } = await admin
      .from('orders')
      .select('*')
      .gte('placed_at', dayStart)
      .lte('placed_at', dayEnd)
      .order('placed_at', { ascending: true })
    if (dayErr) throw dayErr
    targets = (dayRows ?? []).filter((row) => Math.abs(Number(row.total) - targetTotal) < 0.005) as Record<
      string,
      unknown
    >[]
    log('fallback_day_amount_matches', { count: targets.length })
  }

  if (targets.length === 0) {
    // Last resort: dump recent POS pending/cancelled near the window for manual scan.
    const { data: recent, error: recentErr } = await admin
      .from('orders')
      .select(
        'id, order_number, total, status, payment_status, cancellation_reason, cancelled_at, paycloud_merchant_order_no, payment_reference, channel, placed_at, created_at, updated_at, restaurant_id, payment_attempt_started_at, payment_attempt_source',
      )
      .gte('placed_at', windowStart)
      .lte('placed_at', windowEnd)
      .eq('channel', 'pos')
      .order('placed_at', { ascending: true })
    if (recentErr) throw recentErr
    log('NO_11_99_MATCH_recent_pos_in_window', recent)
    throw new Error('No order found with total≈11.99 in search windows')
  }

  for (const order of targets) {
    const orderId = String(order.id)
    log(`ORDER_RAW_${orderId}`, order)

    const { data: audits, error: auditsErr } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_type', 'order')
      .eq('entity_id', orderId)
      .order('created_at', { ascending: true })
    if (auditsErr) throw auditsErr
    log(`AUDIT_LOGS_RAW_${orderId}`, audits)

    const attemptStarted = (audits ?? []).filter((a) => a.action === 'payment.attempt_started')
    log(`ATTEMPT_STARTED_ONLY_${orderId}`, attemptStarted)

    const cancelOrFail = (audits ?? []).filter((a) =>
      ['payment.failed', 'order.cancelled', 'payment.completed'].includes(String(a.action)),
    )
    log(`PAYMENT_OUTCOME_AUDITS_${orderId}`, cancelOrFail)

    const merchantNo = String(order.paycloud_merchant_order_no || '').trim()
    const paymentRef = String(order.payment_reference || '').trim()

    let paymentEventsQuery = admin.from('payment_events').select('*').order('created_at', { ascending: true })
    if (merchantNo) {
      const { data: pe1, error: pe1Err } = await paymentEventsQuery
        .or(
          [
            `idempotency_key.eq.${merchantNo}`,
            `business_order_no.eq.${merchantNo}`,
            `origin_business_order_no.eq.${merchantNo}`,
          ].join(','),
        )
      if (pe1Err) {
        // Retry without or-filter complexity if column names differ
        const { data: peAlt, error: peAltErr } = await admin
          .from('payment_events')
          .select('*')
          .contains('order_ids', [orderId])
          .order('created_at', { ascending: true })
        if (peAltErr) {
          log(`PAYMENT_EVENTS_ERROR_${orderId}`, { pe1Err, peAltErr })
        } else {
          log(`PAYMENT_EVENTS_RAW_${orderId}`, peAlt)
        }
      } else {
        log(`PAYMENT_EVENTS_RAW_${orderId}`, pe1)
      }
    } else {
      const { data: peByOrder, error: peByOrderErr } = await admin
        .from('payment_events')
        .select('*')
        .contains('order_ids', [orderId])
        .order('created_at', { ascending: true })
      if (peByOrderErr) log(`PAYMENT_EVENTS_ERROR_${orderId}`, peByOrderErr)
      else log(`PAYMENT_EVENTS_RAW_${orderId}`, peByOrder)
    }

    log(`ORDER_STATE_SUMMARY_FIELDS_${orderId}`, {
      id: order.id,
      order_number: order.order_number,
      total: order.total,
      status: order.status,
      payment_status: order.payment_status,
      cancellation_reason: order.cancellation_reason,
      cancelled_at: order.cancelled_at,
      paycloud_merchant_order_no: order.paycloud_merchant_order_no,
      payment_reference: order.payment_reference,
      payment_attempt_started_at: order.payment_attempt_started_at ?? null,
      payment_attempt_source: order.payment_attempt_source ?? null,
      channel: order.channel,
      placed_at: order.placed_at,
      created_at: order.created_at,
      updated_at: order.updated_at,
      restaurant_id: order.restaurant_id,
      attempt_started_audit_count: attemptStarted.length,
      payment_ref_echo: paymentRef || null,
    })
  }

  // Cross-order: if two 11.99s exist, clarify same-order retry vs new order.
  log(
    'ALL_MATCHING_ORDER_IDS',
    targets.map((o) => ({
      id: o.id,
      order_number: o.order_number,
      placed_at: o.placed_at,
      paycloud_merchant_order_no: o.paycloud_merchant_order_no,
      cancellation_reason: o.cancellation_reason,
      payment_status: o.payment_status,
    })),
  )
}

main().catch((err) => {
  console.error('INVESTIGATE_UAT_1199_FAILED', err)
  process.exit(1)
})
