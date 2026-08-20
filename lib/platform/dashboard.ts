import { createServerSupabaseClient } from '@/lib/supabase/server'
import { checkPaycloudHealth } from '@/payments/paycloud'
import { RECOVERED_AFTER_AUTO_CANCEL_ACTION } from '@/lib/payments/e04111-recovery'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

export const TERMINAL_OFFLINE_MS = 15 * 60 * 1000
export const DASHBOARD_POLL_INTERVAL_MS = 30_000

export type AlertSeverity = 'critical' | 'warning' | 'info'
export type HealthLevel = 'operational' | 'degraded' | 'outage' | 'unknown'
export type OperatorStatus = 'healthy' | 'attention' | 'degraded' | 'outage' | 'unknown'
export type RestaurantHealthBand = 'healthy' | 'watch' | 'degraded' | 'critical'

export type PlatformAlert = {
  key: string
  severity: AlertSeverity
  title: string
  detail: string
  restaurantId?: string | null
  restaurantName?: string | null
  href?: string
  createdAt: string
  customersAffected?: boolean
  ackStatus?: 'open' | 'acknowledged' | 'resolved' | null
}

export type SystemComponentStatus = {
  id: string
  label: string
  status: HealthLevel
  /** Short relative time or null when healthy / unknown */
  sinceLabel: string | null
  checkedAt: string
  href?: string
}

export type RestaurantHealthScore = {
  restaurantId: string
  name: string
  score: number
  band: RestaurantHealthBand
  issue: string
  ownerName: string | null
  ownerEmail: string | null
  terminalsOnline: number
  terminalsTotal: number
  href: string
}

export type LiveIncident = {
  id: string
  kind: 'payments' | 'terminals' | 'receipts' | 'bugs'
  title: string
  status: OperatorStatus
  summary: string
  href: string
  at: string | null
}

export type CurrentIncident = {
  id: string
  title: string
  summary: string
  status: 'investigating' | 'monitoring' | 'identified'
  startedAt: string
  href: string
} | null

export type ActivityItem = {
  id: string
  at: string
  label: string
  detail?: string
  href?: string
}

function bandForScore(score: number): RestaurantHealthBand {
  if (score >= 90) return 'healthy'
  if (score >= 70) return 'watch'
  if (score >= 40) return 'degraded'
  return 'critical'
}

function worstHealth(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('outage')) return 'outage'
  if (levels.includes('degraded')) return 'degraded'
  if (levels.includes('unknown')) return 'unknown'
  return 'operational'
}

function healthToOperator(status: HealthLevel): OperatorStatus {
  if (status === 'operational') return 'healthy'
  if (status === 'degraded') return 'degraded'
  if (status === 'outage') return 'outage'
  return 'unknown'
}

function relativeShort(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 minute ago'
  if (mins < 60) return `${mins} minutes ago`
  const hrs = Math.floor(mins / 60)
  if (hrs === 1) return '1 hour ago'
  if (hrs < 48) return `${hrs} hours ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

export async function computePlatformAlerts(): Promise<PlatformAlert[]> {
  const supabase = createServerSupabaseClient()
  const now = Date.now()
  const offlineBefore = new Date(now - TERMINAL_OFFLINE_MS).toISOString()
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString()

  const alerts: PlatformAlert[] = []

  const { data: terminals } = await supabase
    .from('restaurant_terminals')
    .select('id, restaurant_id, terminal_name, name, sn, last_seen_at, active, status, restaurants(name)')
    .eq('active', true)
    .eq('status', 'active')
    .lt('last_seen_at', offlineBefore)
    .order('last_seen_at', { ascending: true })
    .limit(50)

  for (const t of terminals ?? []) {
    const restRel = t.restaurants as { name?: string } | { name?: string }[] | null
    const restaurantName = Array.isArray(restRel) ? restRel[0]?.name : restRel?.name
    const label = t.terminal_name || t.name || t.sn || t.id
    alerts.push({
      key: `terminal_offline:${t.id}`,
      severity: 'critical',
      title: 'Terminal offline',
      detail: `${label} last seen ${t.last_seen_at ? new Date(t.last_seen_at).toISOString() : 'never'}`,
      restaurantId: t.restaurant_id,
      restaurantName: restaurantName ?? null,
      href: `/admin/terminals/${t.id}`,
      createdAt: t.last_seen_at || new Date().toISOString(),
      customersAffected: true,
    })
  }

  const { data: failedOrders } = await supabase
    .from('orders')
    .select('id, restaurant_id, payment_status, placed_at, restaurants(name)')
    .eq('payment_status', 'failed')
    .gte('placed_at', hourAgo)
    .limit(100)

  if ((failedOrders?.length ?? 0) >= 3) {
    alerts.push({
      key: `payment_fail_spike:${new Date().toISOString().slice(0, 13)}`,
      severity: 'critical',
      title: 'Payment failure spike',
      detail: `${failedOrders!.length} failed payments in the last hour`,
      href: '/admin/payments?status=failed&range=1h',
      createdAt: new Date().toISOString(),
      customersAffected: true,
    })
  }

  const { data: receiptFails } = await supabase
    .from('audit_logs')
    .select('id, restaurant_id, action, created_at, metadata')
    .eq('action', 'receipt.issuance_failed')
    .gte('created_at', dayAgo)
    .order('created_at', { ascending: false })
    .limit(20)

  for (const row of receiptFails ?? []) {
    alerts.push({
      key: `receipt_issuance_failed:${row.id}`,
      severity: 'warning',
      title: 'Receipt issuance failed',
      detail: `Order ${String((row.metadata as { orderId?: string } | null)?.orderId ?? row.id)}`,
      restaurantId: row.restaurant_id,
      href: row.restaurant_id ? `/admin/restaurants/${row.restaurant_id}?tab=receipts` : '/admin/alerts',
      createdAt: row.created_at,
      customersAffected: true,
    })
  }

  // A payment landed for an order we had already auto-cancelled. Never routine: the
  // auto-cancel was wrong, the customer was charged, and the goods were probably never
  // made. Critical regardless of amount -- a human has to reconcile it.
  const { data: recoveredAfterAutoCancel } = await supabase
    .from('audit_logs')
    .select('id, restaurant_id, action, entity_id, created_at, metadata')
    .eq('action', RECOVERED_AFTER_AUTO_CANCEL_ACTION)
    .gte('created_at', dayAgo)
    .order('created_at', { ascending: false })
    .limit(50)

  for (const row of recoveredAfterAutoCancel ?? []) {
    const meta = (row.metadata ?? {}) as {
      reference?: string
      previousCancellationReason?: string
      amount?: number
    }
    alerts.push({
      key: `payment_recovered_after_auto_cancel:${row.id}`,
      severity: 'critical',
      title: 'Payment recovered after auto-cancel',
      detail:
        `Order ${String(row.entity_id ?? row.id)} was auto-cancelled ` +
        `(${meta.previousCancellationReason || 'unknown reason'}) but the payment is real` +
        `${meta.reference ? ` — ref ${meta.reference}` : ''}. Needs reconciliation.`,
      restaurantId: row.restaurant_id,
      href: row.restaurant_id ? `/admin/restaurants/${row.restaurant_id}?tab=payments` : '/admin/alerts',
      createdAt: row.created_at,
      customersAffected: true,
    })
  }

  const { data: openBugs } = await supabase
    .from('bug_reports')
    .select('id, restaurant_id, description, created_at, status, restaurants(name)')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(20)

  for (const bug of openBugs ?? []) {
    const restRel = bug.restaurants as { name?: string } | { name?: string }[] | null
    const restaurantName = Array.isArray(restRel) ? restRel[0]?.name : restRel?.name
    alerts.push({
      key: `bug_report_open:${bug.id}`,
      severity: 'info',
      title: 'Open bug report',
      detail: String(bug.description || '').slice(0, 120),
      restaurantId: bug.restaurant_id,
      restaurantName: restaurantName ?? null,
      href: `/admin/bug-reports?id=${bug.id}`,
      createdAt: bug.created_at,
      customersAffected: false,
    })
  }

  if (alerts.length > 0) {
    const { data: acks } = await supabase
      .from('platform_alert_acks')
      .select('alert_key, status')
      .in(
        'alert_key',
        alerts.map((a) => a.key),
      )
    const ackMap = new Map((acks ?? []).map((a) => [a.alert_key, a.status as PlatformAlert['ackStatus']]))
    for (const a of alerts) {
      a.ackStatus = ackMap.get(a.key) ?? 'open'
    }
  }

  return alerts.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 }
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    return b.createdAt.localeCompare(a.createdAt)
  })
}

async function probeSystemStatus(now = Date.now()): Promise<SystemComponentStatus[]> {
  const checkedAt = new Date(now).toISOString()
  const supabase = createServerSupabaseClient()
  const components: SystemComponentStatus[] = []

  const { error: dbError } = await supabase.from('restaurants').select('id').limit(1)
  components.push({
    id: 'database',
    label: 'Database',
    status: dbError ? 'outage' : 'operational',
    sinceLabel: null,
    checkedAt,
  })

  components.push({
    id: 'workers',
    label: 'Workers',
    status: 'operational',
    sinceLabel: null,
    checkedAt,
  })

  let paymentsSince: string | null = null
  const { data: lastFail } = await supabase
    .from('orders')
    .select('placed_at')
    .eq('payment_status', 'failed')
    .order('placed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastFail?.placed_at) paymentsSince = relativeShort(lastFail.placed_at, now)

  try {
    const pay = await checkPaycloudHealth()
    const payStatus: HealthLevel = pay.ok ? 'operational' : 'degraded'
    components.push({
      id: 'payments',
      label: 'Payments',
      status: payStatus,
      sinceLabel: payStatus === 'operational' ? null : paymentsSince,
      checkedAt,
      href: '/admin/payments',
    })
  } catch {
    components.push({
      id: 'payments',
      label: 'Payments',
      status: 'unknown',
      sinceLabel: paymentsSince,
      checkedAt,
      href: '/admin/payments',
    })
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  if (redisUrl && redisToken) {
    try {
      const pingRes = await fetch(`${redisUrl.replace(/\/$/, '')}/ping`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        cache: 'no-store',
      })
      components.push({
        id: 'redis',
        label: 'Redis',
        status: pingRes.ok ? 'operational' : 'degraded',
        sinceLabel: null,
        checkedAt,
      })
    } catch {
      components.push({
        id: 'redis',
        label: 'Redis',
        status: 'degraded',
        sinceLabel: null,
        checkedAt,
      })
    }
  } else {
    components.push({
      id: 'redis',
      label: 'Redis',
      status: 'unknown',
      sinceLabel: null,
      checkedAt,
    })
  }

  const emailConfigured = Boolean(process.env.RESEND_API_KEY)
  components.push({
    id: 'email',
    label: 'Email',
    status: emailConfigured ? 'operational' : 'unknown',
    sinceLabel: null,
    checkedAt,
  })

  return components
}

async function computeRestaurantHealthScores(): Promise<RestaurantHealthScore[]> {
  const supabase = createServerSupabaseClient()
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('id, name, is_active, owner_id')
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(40)

  if (!restaurants?.length) return []

  const ids = restaurants.map((r) => r.id)
  const ownerIds = [...new Set(restaurants.map((r) => r.owner_id).filter(Boolean))] as string[]

  const [{ data: terminals }, { data: failedOrders }, { data: receiptFails }, { data: owners }] =
    await Promise.all([
      supabase
        .from('restaurant_terminals')
        .select('id, restaurant_id, last_seen_at, active, status')
        .in('restaurant_id', ids)
        .eq('active', true)
        .eq('status', 'active'),
      // #323: bounded by the 24h window in practice, unbounded in principle. Wrapped so the
      // Promise.all entry still resolves to the { data } shape its destructuring expects.
      fetchAllRows<{ restaurant_id: string }>(
        supabase
          .from('orders')
          .select('restaurant_id')
          .in('restaurant_id', ids)
          .eq('payment_status', 'failed')
          .gte('placed_at', dayAgo),
        { label: 'platformDashboard.failedOrders' },
      ).then((data) => ({ data })),
      supabase
        .from('audit_logs')
        .select('restaurant_id')
        .in('restaurant_id', ids)
        .eq('action', 'receipt.issuance_failed')
        .gte('created_at', dayAgo),
      ownerIds.length
        ? supabase.from('users').select('id, full_name, email').in('id', ownerIds)
        : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null; email: string | null }> }),
    ])

  const ownerMap = new Map(
    (owners ?? []).map((o) => [o.id, { name: o.full_name || o.email || null, email: o.email || null }]),
  )

  const termByRest = new Map<string, { total: number; online: number }>()
  for (const t of terminals ?? []) {
    const cur = termByRest.get(t.restaurant_id) || { total: 0, online: 0 }
    cur.total += 1
    const seen = t.last_seen_at ? new Date(t.last_seen_at).getTime() : 0
    if (seen >= Date.now() - TERMINAL_OFFLINE_MS) cur.online += 1
    termByRest.set(t.restaurant_id, cur)
  }

  const failCount = new Map<string, number>()
  for (const o of failedOrders ?? []) {
    failCount.set(o.restaurant_id, (failCount.get(o.restaurant_id) || 0) + 1)
  }
  const receiptCount = new Map<string, number>()
  for (const r of receiptFails ?? []) {
    if (!r.restaurant_id) continue
    receiptCount.set(r.restaurant_id, (receiptCount.get(r.restaurant_id) || 0) + 1)
  }

  const scores: RestaurantHealthScore[] = restaurants.map((r) => {
    let score = 100
    const factors: string[] = []
    const terms = termByRest.get(r.id) || { total: 0, online: 0 }
    if (terms.total > 0 && terms.online < terms.total) {
      const offline = terms.total - terms.online
      score -= Math.min(45, offline * 25)
      factors.push(offline === 1 ? 'Terminal offline' : `${offline} terminals offline`)
    } else if (terms.total === 0) {
      score -= 5
      factors.push('No active terminals')
    }
    const fails = failCount.get(r.id) || 0
    if (fails >= 5) {
      score -= 25
      factors.push('High payment failure rate')
    } else if (fails >= 1) {
      score -= 10
      factors.push('Payment failures')
    }
    const receipts = receiptCount.get(r.id) || 0
    if (receipts > 0) {
      score -= Math.min(20, receipts * 5)
      factors.push('Receipt failures')
    }
    if (!r.is_active) {
      score -= 30
      factors.push('Restaurant inactive')
    }
    score = Math.max(0, Math.min(100, score))
    const owner = r.owner_id ? ownerMap.get(r.owner_id) : null
    return {
      restaurantId: r.id,
      name: r.name,
      score,
      band: bandForScore(score),
      issue: factors[0] || 'No active issues',
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      terminalsOnline: terms.online,
      terminalsTotal: terms.total,
      href: `/admin/restaurants/${r.id}?tab=timeline`,
    }
  })

  return scores.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
}

export type DashboardPayload = {
  meta: {
    generatedAt: string
    pollIntervalMs: number
  }
  platformStatus: {
    level: HealthLevel
    label: OperatorStatus
    headline: string
  }
  currentIncident: CurrentIncident
  liveIncidents: LiveIncident[]
  systemStatus: SystemComponentStatus[]
  restaurantsNeedingAttention: RestaurantHealthScore[]
  activity: {
    incidents: ActivityItem[]
    audit: ActivityItem[]
    deployments: ActivityItem[]
  }
}

export async function buildDashboardPayload(): Promise<DashboardPayload> {
  const supabase = createServerSupabaseClient()
  const now = Date.now()
  const generatedAt = new Date(now).toISOString()
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const offlineBefore = new Date(now - TERMINAL_OFFLINE_MS).toISOString()

  const [
    systemStatus,
    allAlerts,
    restaurantHealth,
    offlineTerminalsRes,
    failedHourRes,
    lastPaymentFailRes,
    receiptFailsHourRes,
    openBugsRes,
    platformAudits,
  ] = await Promise.all([
    probeSystemStatus(now),
    computePlatformAlerts(),
    computeRestaurantHealthScores(),
    supabase
      .from('restaurant_terminals')
      .select('id, restaurant_id, last_seen_at')
      .eq('active', true)
      .eq('status', 'active')
      .lt('last_seen_at', offlineBefore),
    supabase
      .from('orders')
      .select('id, restaurant_id')
      .eq('payment_status', 'failed')
      .gte('placed_at', hourAgo)
      .limit(200),
    supabase
      .from('orders')
      .select('placed_at')
      .eq('payment_status', 'failed')
      .order('placed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'receipt.issuance_failed')
      .gte('created_at', hourAgo),
    supabase.from('bug_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase
      .from('platform_audit_logs')
      .select('id, action, actor_email, target_type, created_at, success')
      .order('created_at', { ascending: false })
      .limit(12),
  ])

  const openAlerts = allAlerts.filter((a) => a.ackStatus !== 'resolved' && a.ackStatus !== 'acknowledged')
  const criticalCount = openAlerts.filter((a) => a.severity === 'critical').length
  const warningCount = openAlerts.filter((a) => a.severity === 'warning').length
  const systemLevel = worstHealth(systemStatus.map((s) => s.status))

  let platformLevel: HealthLevel = systemLevel
  if (criticalCount > 0) platformLevel = worstHealth([platformLevel, 'degraded'])
  if (criticalCount >= 3 || systemLevel === 'outage') platformLevel = 'outage'
  else if (warningCount > 0) platformLevel = worstHealth([platformLevel, 'degraded'])

  const offlineRows = offlineTerminalsRes.data ?? []
  const offlineCount = offlineRows.length
  const restaurantsOffline = new Set(offlineRows.map((t) => t.restaurant_id)).size
  const oldestOfflineAt = offlineRows
    .map((t) => t.last_seen_at)
    .filter(Boolean)
    .sort()[0] as string | undefined

  const failedHourRows = failedHourRes.data ?? []
  const failedHour = failedHourRows.length
  const restaurantsPaymentFail = new Set(failedHourRows.map((o) => o.restaurant_id)).size
  const receiptFailsHour = receiptFailsHourRes.count ?? 0
  const openBugs = openBugsRes.count ?? 0
  const lastPaymentFailAt = lastPaymentFailRes.data?.placed_at ?? null

  const liveIncidents: LiveIncident[] = []

  const paymentsProbe = systemStatus.find((s) => s.id === 'payments')
  if (failedHour >= 3 || (paymentsProbe && paymentsProbe.status !== 'operational')) {
    liveIncidents.push({
      id: 'payments',
      kind: 'payments',
      title: 'Payments',
      status: failedHour >= 3 || paymentsProbe?.status === 'outage' ? 'degraded' : 'attention',
      summary: lastPaymentFailAt
        ? `Last failure ${relativeShort(lastPaymentFailAt, now)}`
        : `${failedHour} failures in the last hour`,
      href: '/admin/payments?status=failed&range=1h',
      at: lastPaymentFailAt,
    })
  }

  if (offlineCount > 0) {
    liveIncidents.push({
      id: 'terminals',
      kind: 'terminals',
      title: 'Offline terminals',
      status: offlineCount >= 5 ? 'degraded' : 'attention',
      summary: `${offlineCount} device${offlineCount === 1 ? '' : 's'} · ${restaurantsOffline} restaurant${restaurantsOffline === 1 ? '' : 's'}`,
      href: '/admin/terminals?status=offline',
      at: oldestOfflineAt ?? null,
    })
  }

  if (receiptFailsHour > 0) {
    liveIncidents.push({
      id: 'receipts',
      kind: 'receipts',
      title: 'Receipt failures',
      status: 'attention',
      summary: `${receiptFailsHour} in last hour`,
      href: '/admin/alerts',
      at: null,
    })
  }

  if (openBugs > 0) {
    liveIncidents.push({
      id: 'bugs',
      kind: 'bugs',
      title: 'Open bugs',
      status: 'attention',
      summary: `${openBugs} open`,
      href: '/admin/bug-reports',
      at: null,
    })
  }

  // Current incident — only when something material is on fire; else omit entirely
  let currentIncident: CurrentIncident = null
  const paymentSpike = openAlerts.find((a) => a.key.startsWith('payment_fail_spike'))
  const primary = paymentSpike || openAlerts.find((a) => a.severity === 'critical' && a.customersAffected)
  if (paymentSpike || failedHour >= 3) {
    currentIncident = {
      id: paymentSpike?.key || 'payments-elevated',
      title: 'Payment provider experiencing elevated failures',
      summary:
        restaurantsPaymentFail > 0
          ? `Payment failures affecting ${restaurantsPaymentFail} restaurants`
          : `${failedHour} failed payments in the last hour`,
      status: 'investigating',
      startedAt: paymentSpike?.createdAt || lastPaymentFailAt || generatedAt,
      href: '/admin/payments?status=failed&range=1h',
    }
  } else if (primary) {
    currentIncident = {
      id: primary.key,
      title: primary.title,
      summary:
        primary.key.startsWith('terminal_offline')
          ? `${offlineCount} terminals offline across ${restaurantsOffline} restaurants`
          : primary.detail,
      status: 'investigating',
      startedAt: primary.createdAt,
      href: primary.href || '/admin/alerts',
    }
  }

  const headline = currentIncident
    ? currentIncident.summary
    : platformLevel === 'operational'
      ? 'All systems nominal'
      : liveIncidents[0]?.summary || 'Action required on open incidents'

  const restaurantsNeedingAttention = restaurantHealth
    .filter((r) => r.band === 'critical' || r.band === 'degraded' || r.band === 'watch')
    .slice(0, 5)

  const activityIncidents: ActivityItem[] = openAlerts.slice(0, 8).map((a) => ({
    id: a.key,
    at: a.createdAt,
    label: a.title,
    detail: a.restaurantName || a.detail,
    href: a.href,
  }))

  const activityAudit: ActivityItem[] = (platformAudits.data ?? []).map((row) => ({
    id: `pa-${row.id}`,
    at: row.created_at,
    label: row.action,
    detail: `${row.actor_email || 'system'}${row.success === false ? ' · failed' : ''}`,
    href: '/admin/audit-logs',
  }))

  const activityDeployments: ActivityItem[] = (platformAudits.data ?? [])
    .filter((row) => /deploy|release|worker|migration/i.test(row.action))
    .map((row) => ({
      id: `dep-${row.id}`,
      at: row.created_at,
      label: row.action,
      detail: row.actor_email || 'system',
      href: '/admin/audit-logs',
    }))

  // Soften payments probe sinceLabel when degraded
  for (const c of systemStatus) {
    if (c.id === 'payments' && c.status !== 'operational' && !c.sinceLabel && lastPaymentFailAt) {
      c.sinceLabel = relativeShort(lastPaymentFailAt, now)
    }
  }

  return {
    meta: { generatedAt, pollIntervalMs: DASHBOARD_POLL_INTERVAL_MS },
    platformStatus: {
      level: platformLevel,
      label: healthToOperator(platformLevel),
      headline,
    },
    currentIncident,
    liveIncidents,
    systemStatus,
    restaurantsNeedingAttention,
    activity: {
      incidents: activityIncidents,
      audit: activityAudit,
      deployments: activityDeployments,
    },
  }
}
