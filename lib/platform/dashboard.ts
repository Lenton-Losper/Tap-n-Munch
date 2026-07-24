import { createServerSupabaseClient } from '@/lib/supabase/server'
import { checkPaycloudHealth } from '@/payments/paycloud'

export const TERMINAL_OFFLINE_MS = 15 * 60 * 1000
export const DASHBOARD_POLL_INTERVAL_MS = 30_000

export type AlertSeverity = 'critical' | 'warning' | 'info'
export type HealthLevel = 'operational' | 'degraded' | 'outage' | 'unknown'
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
  detail: string
  checkedAt: string
  href?: string
}

export type RestaurantHealthScore = {
  restaurantId: string
  name: string
  score: number
  band: RestaurantHealthBand
  factors: string[]
  terminalsOnline: number
  terminalsTotal: number
  href: string
}

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
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
      href: '/admin/payments',
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

async function probeSystemStatus(): Promise<SystemComponentStatus[]> {
  const checkedAt = new Date().toISOString()
  const supabase = createServerSupabaseClient()
  const components: SystemComponentStatus[] = []

  // Database
  const dbStarted = Date.now()
  const { error: dbError } = await supabase.from('restaurants').select('id').limit(1)
  components.push({
    id: 'database',
    label: 'Database',
    status: dbError ? 'outage' : 'operational',
    detail: dbError ? dbError.message : `Supabase OK · ${Date.now() - dbStarted}ms`,
    checkedAt,
  })

  // Workers — if this handler runs on Cloudflare, the worker path is up.
  components.push({
    id: 'workers',
    label: 'Cloudflare Workers',
    status: 'operational',
    detail: 'Request served by production/staging worker',
    checkedAt,
  })

  // Payments (Finatic/Paycloud)
  try {
    const pay = await checkPaycloudHealth()
    components.push({
      id: 'payments',
      label: 'Payments gateway',
      status: pay.ok ? 'operational' : 'degraded',
      detail: pay.ok
        ? `Paycloud ${pay.status || 'ok'}`
        : String(pay.error || pay.status || 'gateway unhealthy'),
      checkedAt,
      href: '/admin/payments',
    })
  } catch (e) {
    components.push({
      id: 'payments',
      label: 'Payments gateway',
      status: 'unknown',
      detail: e instanceof Error ? e.message : 'Health check failed',
      checkedAt,
      href: '/admin/payments',
    })
  }

  // Redis / Upstash
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
        detail: pingRes.ok ? 'Upstash reachable' : `HTTP ${pingRes.status}`,
        checkedAt,
      })
    } catch (e) {
      components.push({
        id: 'redis',
        label: 'Redis',
        status: 'degraded',
        detail: e instanceof Error ? e.message : 'Unreachable',
        checkedAt,
      })
    }
  } else {
    components.push({
      id: 'redis',
      label: 'Redis',
      status: 'unknown',
      detail: 'Not configured in this environment',
      checkedAt,
    })
  }

  // Email
  const emailConfigured = Boolean(process.env.RESEND_API_KEY)
  components.push({
    id: 'email',
    label: 'Email',
    status: emailConfigured ? 'operational' : 'unknown',
    detail: emailConfigured ? 'Resend configured' : 'RESEND_API_KEY not set',
    checkedAt,
  })

  return components
}

async function computeRestaurantHealthScores(): Promise<RestaurantHealthScore[]> {
  const supabase = createServerSupabaseClient()
  const offlineBefore = new Date(Date.now() - TERMINAL_OFFLINE_MS).toISOString()
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('id, name, is_active')
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(40)

  if (!restaurants?.length) return []

  const ids = restaurants.map((r) => r.id)
  const [{ data: terminals }, { data: failedOrders }, { data: receiptFails }] = await Promise.all([
    supabase
      .from('restaurant_terminals')
      .select('id, restaurant_id, last_seen_at, active, status')
      .in('restaurant_id', ids)
      .eq('active', true)
      .eq('status', 'active'),
    supabase
      .from('orders')
      .select('restaurant_id')
      .in('restaurant_id', ids)
      .eq('payment_status', 'failed')
      .gte('placed_at', dayAgo),
    supabase
      .from('audit_logs')
      .select('restaurant_id')
      .in('restaurant_id', ids)
      .eq('action', 'receipt.issuance_failed')
      .gte('created_at', dayAgo),
  ])

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
      factors.push(`${offline}/${terms.total} terminals offline`)
    } else if (terms.total === 0) {
      score -= 5
      factors.push('No active terminals')
    }
    const fails = failCount.get(r.id) || 0
    if (fails >= 5) {
      score -= 25
      factors.push(`${fails} failed payments (24h)`)
    } else if (fails >= 1) {
      score -= 10
      factors.push(`${fails} failed payments (24h)`)
    }
    const receipts = receiptCount.get(r.id) || 0
    if (receipts > 0) {
      score -= Math.min(20, receipts * 5)
      factors.push(`${receipts} receipt issuance failures (24h)`)
    }
    if (!r.is_active) {
      score -= 30
      factors.push('Restaurant inactive')
    }
    if (factors.length === 0) factors.push('No active issues')
    score = Math.max(0, Math.min(100, score))
    return {
      restaurantId: r.id,
      name: r.name,
      score,
      band: bandForScore(score),
      factors,
      terminalsOnline: terms.online,
      terminalsTotal: terms.total,
      href: `/admin/restaurants/${r.id}`,
    }
  })

  return scores.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
}

export type DashboardPayload = {
  meta: {
    generatedAt: string
    pollIntervalMs: number
  }
  platformHealth: {
    status: HealthLevel
    summary: string
    customersAffected: boolean
    criticalCount: number
    warningCount: number
  }
  systemStatus: SystemComponentStatus[]
  needsAttention: PlatformAlert[]
  customersAffected: PlatformAlert[]
  goNext: Array<{ label: string; href: string; reason: string }>
  restaurantHealth: RestaurantHealthScore[]
  incidentTimeline: Array<{
    id: string
    at: string
    kind: 'incident'
    severity: AlertSeverity
    label: string
    detail?: string
    href?: string
  }>
  recentChanges: Array<{
    id: string
    at: string
    kind: 'audit'
    label: string
    detail?: string
    href?: string
  }>
  kpis: {
    revenueToday: number
    revenueMonth: number
    ordersToday: number
    ordersMonth: number
    activeRestaurants: number
    newRestaurantsMonth: number
    onlineTerminals: number
    totalActiveTerminals: number
    failedPaymentsToday: number
    paidOrdersToday: number
    paymentSuccessRate: number | null
    failedWebhooksProxy: number
    openBugReports: number
  }
  /** Kept for analytics section; not the primary ops view. */
  series24h: Array<{ hour: string; orders: number; revenue: number }>
}

export async function buildDashboardPayload(): Promise<DashboardPayload> {
  const supabase = createServerSupabaseClient()
  const now = new Date()
  const generatedAt = now.toISOString()
  const dayStart = startOfUtcDay(now).toISOString()
  const monthStart = startOfUtcMonth(now).toISOString()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const offlineBefore = new Date(now.getTime() - TERMINAL_OFFLINE_MS).toISOString()

  const [
    paidTodayRes,
    paidMonthRes,
    ordersTodayCount,
    ordersMonthCount,
    activeRestaurants,
    newRestaurants,
    terminalsOnline,
    terminalsActive,
    failedToday,
    paidTodayCount,
    receiptFailsHour,
    openBugs,
    platformAudits,
    systemStatus,
    allAlerts,
    restaurantHealth,
  ] = await Promise.all([
    supabase.from('orders').select('total').eq('payment_status', 'paid').gte('paid_at', dayStart),
    supabase.from('orders').select('total').eq('payment_status', 'paid').gte('paid_at', monthStart),
    supabase.from('orders').select('id', { count: 'exact', head: true }).gte('placed_at', dayStart),
    supabase.from('orders').select('id', { count: 'exact', head: true }).gte('placed_at', monthStart),
    supabase.from('restaurants').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('restaurants').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
    supabase
      .from('restaurant_terminals')
      .select('id', { count: 'exact', head: true })
      .eq('active', true)
      .eq('status', 'active')
      .gte('last_seen_at', offlineBefore),
    supabase
      .from('restaurant_terminals')
      .select('id', { count: 'exact', head: true })
      .eq('active', true)
      .eq('status', 'active'),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'failed')
      .gte('placed_at', dayStart),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'paid')
      .gte('paid_at', dayStart),
    supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'receipt.issuance_failed')
      .gte('created_at', new Date(now.getTime() - 60 * 60 * 1000).toISOString()),
    supabase.from('bug_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase
      .from('platform_audit_logs')
      .select('id, action, actor_email, target_type, target_id, created_at, success')
      .order('created_at', { ascending: false })
      .limit(20),
    probeSystemStatus(),
    computePlatformAlerts(),
    computeRestaurantHealthScores(),
  ])

  const sumTotals = (rows: Array<{ total: number | string } | null> | null | undefined) =>
    (rows ?? []).reduce((s, r) => s + Number(r?.total || 0), 0)

  const paidToday = paidTodayCount.count ?? 0
  const failedTodayN = failedToday.count ?? 0
  const attempts = paidToday + failedTodayN
  const paymentSuccessRate = attempts > 0 ? Math.round((paidToday / attempts) * 1000) / 10 : null

  const { data: recentOrders } = await supabase
    .from('orders')
    .select('placed_at, total, payment_status')
    .gte('placed_at', dayAgo)
    .order('placed_at', { ascending: true })
    .limit(5000)

  const buckets = new Map<string, { orders: number; revenue: number }>()
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
    buckets.set(key, { orders: 0, revenue: 0 })
  }
  for (const o of recentOrders ?? []) {
    const d = new Date(o.placed_at)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
    const b = buckets.get(key)
    if (!b) continue
    b.orders += 1
    if (String(o.payment_status).toLowerCase() === 'paid') b.revenue += Number(o.total || 0)
  }
  const series24h = Array.from(buckets.entries()).map(([hour, v]) => ({
    hour: `${hour}:00Z`,
    orders: v.orders,
    revenue: Math.round(v.revenue * 100) / 100,
  }))

  const needsAttention = allAlerts.filter(
    (a) => a.severity !== 'info' && a.ackStatus !== 'resolved' && a.ackStatus !== 'acknowledged',
  )
  const customersAffected = needsAttention.filter((a) => a.customersAffected)

  const criticalCount = needsAttention.filter((a) => a.severity === 'critical').length
  const warningCount = needsAttention.filter((a) => a.severity === 'warning').length
  const systemLevel = worstHealth(systemStatus.map((s) => s.status))
  let platformStatus: HealthLevel = systemLevel
  if (criticalCount > 0) platformStatus = worstHealth([platformStatus, 'degraded'])
  if (criticalCount >= 3 || systemLevel === 'outage') platformStatus = 'outage'
  else if (warningCount > 0 || customersAffected.length > 0) {
    platformStatus = worstHealth([platformStatus, 'degraded'])
  }

  const summary =
    platformStatus === 'operational'
      ? 'All systems nominal — no customer-impacting incidents.'
      : platformStatus === 'outage'
        ? 'Severe degradation — customer-facing failures detected.'
        : platformStatus === 'degraded'
          ? 'Degraded — action required on open incidents.'
          : 'Health partially unknown — verify system probes.'

  const incidentTimeline = needsAttention.slice(0, 25).map((a) => ({
    id: a.key,
    at: a.createdAt,
    kind: 'incident' as const,
    severity: a.severity,
    label: a.title,
    detail: [a.restaurantName, a.detail].filter(Boolean).join(' · '),
    href: a.href,
  }))

  const recentChanges = (platformAudits.data ?? []).map((row) => ({
    id: `pa-${row.id}`,
    at: row.created_at,
    kind: 'audit' as const,
    label: row.action,
    detail: `${row.actor_email || 'system'} · ${row.target_type}${row.success === false ? ' (failed)' : ''}`,
    href: '/admin/audit-logs',
  }))

  const goNext: DashboardPayload['goNext'] = []
  if (needsAttention.length > 0) {
    goNext.push({
      label: 'Open alerts inbox',
      href: '/admin/alerts',
      reason: `${needsAttention.length} items need action`,
    })
  }
  if (customersAffected.some((a) => a.key.startsWith('terminal_offline'))) {
    goNext.push({
      label: 'Terminal fleet',
      href: '/admin/terminals',
      reason: 'Offline devices may block card presentment',
    })
  }
  if (customersAffected.some((a) => a.key.startsWith('payment_fail'))) {
    goNext.push({
      label: 'Payments hub',
      href: '/admin/payments',
      reason: 'Investigate failed card / webhook correlation',
    })
  }
  const worstRestaurants = restaurantHealth.filter((r) => r.band === 'critical' || r.band === 'degraded').slice(0, 3)
  for (const r of worstRestaurants) {
    goNext.push({
      label: r.name,
      href: r.href,
      reason: `Health score ${r.score} · ${r.factors[0]}`,
    })
  }
  if (goNext.length === 0) {
    goNext.push({
      label: 'Restaurant fleet',
      href: '/admin/restaurants',
      reason: 'Review merchant health scores',
    })
    goNext.push({
      label: 'Audit logs',
      href: '/admin/audit-logs',
      reason: 'Review recent privileged changes',
    })
  }

  return {
    meta: { generatedAt, pollIntervalMs: DASHBOARD_POLL_INTERVAL_MS },
    platformHealth: {
      status: platformStatus,
      summary,
      customersAffected: customersAffected.length > 0,
      criticalCount,
      warningCount,
    },
    systemStatus,
    needsAttention: needsAttention.slice(0, 12),
    customersAffected: customersAffected.slice(0, 8),
    goNext: goNext.slice(0, 6),
    restaurantHealth: restaurantHealth.slice(0, 12),
    incidentTimeline,
    recentChanges,
    kpis: {
      revenueToday: Math.round(sumTotals(paidTodayRes.data as Array<{ total: number }> | null) * 100) / 100,
      revenueMonth: Math.round(sumTotals(paidMonthRes.data as Array<{ total: number }> | null) * 100) / 100,
      ordersToday: ordersTodayCount.count ?? 0,
      ordersMonth: ordersMonthCount.count ?? 0,
      activeRestaurants: activeRestaurants.count ?? 0,
      newRestaurantsMonth: newRestaurants.count ?? 0,
      onlineTerminals: terminalsOnline.count ?? 0,
      totalActiveTerminals: terminalsActive.count ?? 0,
      failedPaymentsToday: failedTodayN,
      paidOrdersToday: paidToday,
      paymentSuccessRate,
      failedWebhooksProxy: receiptFailsHour.count ?? 0,
      openBugReports: openBugs.count ?? 0,
    },
    series24h,
  }
}
