/**
 * Read-only follow-up: expand around the NAD 11.99 Finatic-UAT decline.
 * Also dump nearby POS orders + any payment.failed / attempt_started audits
 * from the same terminal around the window (covers Try-again / late cancels).
 *
 * Trigger: commit message contains [investigate-uat-1199-followup]
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

const ORDER_ID = 'fc059012-2f97-4121-a170-dff1df3ad3a7'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TERMINAL_ID = '1ff83871-35c3-4eba-971f-0f4ca827c86a'
const BUSINESS_ORDER_NO = 'FT17852482265916501'

function log(label: string, value: unknown) {
  console.log(`\n===== ${label} =====`)
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  const { data: order, error: orderErr } = await admin.from('orders').select('*').eq('id', ORDER_ID).maybeSingle()
  if (orderErr) throw orderErr
  log('ORDER_RECHECK', order)

  const { data: audits, error: auditsErr } = await admin
    .from('audit_logs')
    .select('*')
    .eq('entity_type', 'order')
    .eq('entity_id', ORDER_ID)
    .order('created_at', { ascending: true })
  if (auditsErr) throw auditsErr
  log('ORDER_AUDITS_RECHECK', audits)

  const { data: todayPos, error: todayErr } = await admin
    .from('orders')
    .select(
      'id, order_number, total, status, payment_status, cancellation_reason, cancelled_at, paycloud_merchant_order_no, payment_reference, channel, placed_at, updated_at, restaurant_id, terminal_sn, payment_method',
    )
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('channel', 'pos')
    .gte('placed_at', '2026-07-28T13:00:00.000Z')
    .lte('placed_at', '2026-07-28T16:00:00.000Z')
    .order('placed_at', { ascending: true })
  if (todayErr) throw todayErr
  log('TODAY_POS_ORDERS_RESTAURANT', todayPos)

  const { data: recentAudits, error: recentAuditsErr } = await admin
    .from('audit_logs')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
    .in('action', [
      'payment.attempt_started',
      'payment.failed',
      'order.cancelled',
      'payment.completed',
    ])
    .gte('created_at', '2026-07-28T13:00:00.000Z')
    .lte('created_at', '2026-07-28T16:00:00.000Z')
    .order('created_at', { ascending: true })
  if (recentAuditsErr) throw recentAuditsErr
  log('RECENT_PAYMENT_AUDITS_RESTAURANT', recentAudits)

  const terminalAudits = (recentAudits ?? []).filter((row) => {
    const meta = (row.metadata || {}) as Record<string, unknown>
    return (
      meta.terminalId === TERMINAL_ID ||
      meta.terminalSn === `ft-${TERMINAL_ID}` ||
      meta.businessOrderNo === BUSINESS_ORDER_NO ||
      String(meta.businessOrderNo || '').startsWith('FT178524')
    )
  })
  log('FILTERED_TERMINAL_OR_FT178524_AUDITS', terminalAudits)

  const { data: allTodayAudits, error: allTodayErr } = await admin
    .from('audit_logs')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
    .gte('created_at', '2026-07-28T13:00:00.000Z')
    .lte('created_at', '2026-07-28T16:00:00.000Z')
    .order('created_at', { ascending: true })
    .limit(200)
  if (allTodayErr) throw allTodayErr
  const n003ish = (allTodayAudits ?? []).filter((row) => {
    const blob = JSON.stringify(row.metadata || {})
    return /N003|not a confirmed success|payment_declined|finaticVerifiedBeforeCancel/i.test(blob)
  })
  log('AUDITS_WITH_DECLINE_MARKERS', n003ish)

  const otherOrderIds = [
    ...new Set(
      (recentAudits ?? [])
        .filter((a) => a.action === 'payment.attempt_started')
        .map((a) => String(a.entity_id))
        .filter((id) => id && id !== ORDER_ID),
    ),
  ]
  log('OTHER_ATTEMPT_STARTED_ORDER_IDS', otherOrderIds)

  for (const oid of otherOrderIds) {
    const { data: o } = await admin.from('orders').select('*').eq('id', oid).maybeSingle()
    log(`OTHER_ORDER_RAW_${oid}`, o)
    const { data: a } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_type', 'order')
      .eq('entity_id', oid)
      .order('created_at', { ascending: true })
    log(`OTHER_ORDER_AUDITS_${oid}`, a)
  }
}

main().catch((err) => {
  console.error('INVESTIGATE_UAT_1199_FOLLOWUP_FAILED', err)
  process.exit(1)
})
