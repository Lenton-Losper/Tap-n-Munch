import { createServerSupabaseClient } from '@/lib/supabase/server'

export const TERMINAL_OFFLINE_MS = 15 * 60 * 1000

export type AlertSeverity = 'critical' | 'warning' | 'info'

export type PlatformAlert = {
  key: string
  severity: AlertSeverity
  title: string
  detail: string
  restaurantId?: string | null
  restaurantName?: string | null
  href?: string
  createdAt: string
  ackStatus?: 'open' | 'acknowledged' | 'resolved' | null
}

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
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
    })
  }

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

  return alerts.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 }
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    return b.createdAt.localeCompare(a.createdAt)
  })
}

export type DashboardPayload = {
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
  series24h: Array<{ hour: string; orders: number; revenue: number }>
  attention: PlatformAlert[]
  activity: Array<{
    id: string
    at: string
    source: 'platform_audit' | 'audit' | 'payment'
    label: string
    detail?: string
    href?: string
  }>
  gatewayHealth: { ok: boolean; status?: string; error?: string | null }
}

export async function buildDashboardPayload(): Promise<DashboardPayload> {
  const supabase = createServerSupabaseClient()
  const now = new Date()
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
    tenantAudits,
    saleEvents,
  ] = await Promise.all([
    supabase
      .from('orders')
      .select('total')
      .eq('payment_status', 'paid')
      .gte('paid_at', dayStart),
    supabase
      .from('orders')
      .select('total')
      .eq('payment_status', 'paid')
      .gte('paid_at', monthStart),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .gte('placed_at', dayStart),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .gte('placed_at', monthStart),
    supabase
      .from('restaurants')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true),
    supabase
      .from('restaurants')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', monthStart),
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
    supabase
      .from('bug_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open'),
    supabase
      .from('platform_audit_logs')
      .select('id, action, actor_email, target_type, target_id, created_at, success')
      .order('created_at', { ascending: false })
      .limit(25),
    supabase
      .from('audit_logs')
      .select('id, action, restaurant_id, entity_id, created_at')
      .order('created_at', { ascending: false })
      .limit(25),
    supabase
      .from('payment_events')
      .select('id, event_type, amount, restaurant_id, business_order_no, created_at')
      .eq('event_type', 'sale')
      .order('created_at', { ascending: false })
      .limit(25),
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
    if (String(o.payment_status).toLowerCase() === 'paid') {
      b.revenue += Number(o.total || 0)
    }
  }

  const series24h = Array.from(buckets.entries()).map(([hour, v]) => ({
    hour: `${hour}:00Z`,
    orders: v.orders,
    revenue: Math.round(v.revenue * 100) / 100,
  }))

  const allAlerts = await computePlatformAlerts()
  const attention = allAlerts.filter((a) => a.severity !== 'info' && a.ackStatus !== 'resolved').slice(0, 12)

  const activity: DashboardPayload['activity'] = []
  for (const row of platformAudits.data ?? []) {
    activity.push({
      id: `pa-${row.id}`,
      at: row.created_at,
      source: 'platform_audit',
      label: row.action,
      detail: `${row.actor_email || 'system'} · ${row.target_type}${row.success === false ? ' (failed)' : ''}`,
      href: '/admin/audit-logs',
    })
  }
  for (const row of tenantAudits.data ?? []) {
    activity.push({
      id: `al-${row.id}`,
      at: row.created_at,
      source: 'audit',
      label: row.action,
      detail: row.entity_id ? `entity ${row.entity_id}` : undefined,
      href: row.restaurant_id ? `/admin/restaurants/${row.restaurant_id}?tab=audit` : undefined,
    })
  }
  for (const row of saleEvents.data ?? []) {
    activity.push({
      id: `pe-${row.id}`,
      at: row.created_at,
      source: 'payment',
      label: 'payment.sale',
      detail: `${row.business_order_no} · N$${Number(row.amount).toFixed(2)}`,
      href: `/admin/payments/lookup?q=${encodeURIComponent(row.business_order_no)}`,
    })
  }
  activity.sort((a, b) => b.at.localeCompare(a.at))

  // Gateway deep-check is exposed via /api/payments/health; dashboard surfaces a soft status.
  const gatewayHealth: DashboardPayload['gatewayHealth'] = {
    ok: true,
    status: 'see_/api/payments/health',
  }

  return {
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
    attention,
    activity: activity.slice(0, 40),
    gatewayHealth,
  }
}
