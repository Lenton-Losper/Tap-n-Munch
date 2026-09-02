import Link from 'next/link'
import { VenueStationScreens, type VenueStationScreen } from '@/components/admin/venue-station-screens'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, HealthBadge } from '@/components/platform/ops-shell'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { FEATURE_FLAG_KEYS, type FeatureFlagsState } from './constants'
import { FeatureFlagsPanel } from './feature-flags-panel'

export const dynamic = 'force-dynamic'

const FEATURE_COLUMNS = FEATURE_FLAG_KEYS.join(', ')
const TAB_KEYS = [
  'overview',
  'timeline',
  'users',
  'menus',
  'orders',
  'payments',
  'receipts',
  'terminals',
  'tables',
  'integrations',
  'billing',
  'audit',
  'settings',
] as const

type TabKey = (typeof TAB_KEYS)[number]
type DataRow = Record<string, unknown>

function relationValue(value: unknown) {
  if (Array.isArray(value)) return (value[0] || null) as DataRow | null
  return value && typeof value === 'object' ? (value as DataRow) : null
}

function formatDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-NA', { dateStyle: 'medium', timeStyle: 'short' })
}

function money(value: unknown) {
  return `N$${Number(value || 0).toLocaleString('en-NA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function normalizeFeatures(raw: DataRow | null): FeatureFlagsState {
  return FEATURE_FLAG_KEYS.reduce((state, key) => {
    state[key] = Boolean(raw?.[key])
    return state
  }, {} as FeatureFlagsState)
}

function Card({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-[#E8E6E1] bg-white">
      <div className="border-b border-[#E8E6E1] px-5 py-4">
        <h2 className="text-sm font-semibold text-[#1A1A1A]">{title}</h2>
        {description ? <p className="mt-1 text-xs text-[#8A867C]">{description}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function StatusBadge({ value }: { value: unknown }) {
  return (
    <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
      {String(value || 'unknown').replace(/_/g, ' ')}
    </Badge>
  )
}

type TimelineEvent = {
  id: string
  at: string
  label: string
  detail?: string
}

function buildRestaurantTimeline(input: {
  terminals: DataRow[]
  orders: DataRow[]
  payments: DataRow[]
  receipts: DataRow[]
  audits: DataRow[]
  loadedAt: number
}): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const offlineMs = 15 * 60 * 1000

  for (const terminal of input.terminals) {
    const label = String(terminal.terminal_name || terminal.name || terminal.sn || 'Terminal')
    if (terminal.last_seen_at) {
      const seen = new Date(String(terminal.last_seen_at)).getTime()
      const online =
        terminal.active &&
        terminal.status === 'active' &&
        input.loadedAt - seen < offlineMs
      events.push({
        id: `term-seen-${terminal.id}`,
        at: String(terminal.last_seen_at),
        label: online ? `Terminal ${label} heartbeat` : `Terminal ${label} disconnected`,
        detail: online ? 'Last seen within heartbeat window' : 'No heartbeat within 15 minutes',
      })
    }
    if (terminal.created_at) {
      events.push({
        id: `term-created-${terminal.id}`,
        at: String(terminal.created_at),
        label: `Terminal ${label} registered`,
      })
    }
  }

  for (const order of input.orders) {
    if (order.placed_at) {
      events.push({
        id: `order-placed-${order.id}`,
        at: String(order.placed_at),
        label: `Order #${order.order_number || order.id} placed`,
        detail: `${String(order.channel || 'order')} · ${String(order.payment_status || '')}`,
      })
    }
    if (order.paid_at) {
      events.push({
        id: `order-paid-${order.id}`,
        at: String(order.paid_at),
        label: `Order #${order.order_number || order.id} marked paid`,
      })
    }
    if (String(order.payment_status || '').toLowerCase() === 'failed' && order.placed_at) {
      events.push({
        id: `order-fail-${order.id}`,
        at: String(order.placed_at),
        label: `Customer payment failed`,
        detail: `Order #${order.order_number || order.id}`,
      })
    }
  }

  for (const payment of input.payments) {
    if (!payment.created_at) continue
    const type = String(payment.event_type || 'payment')
    events.push({
      id: `pay-${payment.id}`,
      at: String(payment.created_at),
      label: type.toLowerCase().includes('fail')
        ? 'Payment event failed'
        : type.toLowerCase().includes('sale') || type.toLowerCase().includes('success')
          ? 'Webhook / payment event received'
          : `Payment event · ${type}`,
      detail: String(
        payment.business_order_no ||
          payment.gateway_result_message ||
          payment.gateway_result_code ||
          '',
      ),
    })
  }

  for (const receipt of input.receipts) {
    if (!receipt.issued_at) continue
    events.push({
      id: `rcpt-${receipt.id}`,
      at: String(receipt.issued_at),
      label:
        String(receipt.status || '').toLowerCase().includes('fail')
          ? 'Receipt issuance failed'
          : 'Receipt generated',
      detail: String(receipt.document_number || receipt.document_type || ''),
    })
  }

  for (const audit of input.audits) {
    if (!audit.created_at) continue
    const action = String(audit.action || 'event')
    events.push({
      id: `audit-${audit.id}`,
      at: String(audit.created_at),
      label:
        action === 'receipt.issuance_failed'
          ? 'Receipt generation failed'
          : action.includes('print')
            ? 'Print event'
            : action.includes('bug') || action.includes('report')
              ? 'Manager reported issue'
              : action.replace(/\./g, ' '),
      detail: String(audit.entity_type || ''),
    })
  }

  return events
    .filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 80)
}

async function loadRestaurant(id: string) {
  const supabase = createServerSupabaseClient()
  const [
    restaurantRes,
    featuresRes,
    subscriptionRes,
    usersRes,
    ordersRes,
    paymentEventsRes,
    terminalsRes,
    tablesRes,
    auditsRes,
    categoriesRes,
    itemsRes,
    receiptsRes,
  ] = await Promise.all([
    supabase
      .from('restaurants')
      .select(
        'id, owner_id, name, slug, phone, address, currency, timezone, created_at, updated_at, activated_at, is_active, online_ordering_enabled, finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no',
      )
      .eq('id', id)
      .maybeSingle(),
    supabase.from('restaurant_features').select(FEATURE_COLUMNS).eq('restaurant_id', id).maybeSingle(),
    supabase
      .from('subscriptions')
      .select('plan, status, trial_ends_at, renews_at, created_at')
      .eq('restaurant_id', id)
      .maybeSingle(),
    supabase
      .from('restaurant_users')
      .select('id, user_id, role, invite_accepted, created_at, users!restaurant_users_user_id_fkey(email)')
      .eq('restaurant_id', id)
      .is('deleted_at', null)
      .order('created_at'),
    supabase
      .from('orders')
      .select('id, order_number, table_number, channel, status, payment_status, total, placed_at, paid_at')
      .eq('restaurant_id', id)
      .order('placed_at', { ascending: false })
      .limit(50),
    supabase
      .from('payment_events')
      .select('id, order_ids, event_type, business_order_no, amount, currency, gateway_result_code, gateway_result_message, created_at')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('restaurant_terminals')
      .select('id, terminal_name, name, sn, model, app_version, active, status, last_seen_at, created_at, station_kind, activated_at')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('restaurant_tables')
      .select('id, table_number, table_name, status, active, is_kiosk, created_at')
      .eq('restaurant_id', id)
      .order('table_number'),
    supabase
      .from('audit_logs')
      .select('id, action, entity_type, entity_id, metadata, created_at')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('menu_categories')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', id),
    supabase
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', id),
    supabase
      .from('receipt_documents')
      .select('id, order_id, document_number, document_type, status, currency, issued_at')
      .eq('restaurant_id', id)
      .order('issued_at', { ascending: false })
      .limit(50),
  ])

  const restaurant = restaurantRes.data as DataRow | null
  if (!restaurant) return null

  let ownerEmail: string | null = null
  if (restaurant.owner_id) {
    const { data: owner } = await supabase
      .from('users')
      .select('email')
      .eq('id', restaurant.owner_id)
      .maybeSingle()
    ownerEmail = owner?.email || null
  }

  return {
    loadedAt: Date.now(),
    restaurant,
    ownerEmail,
    features: (featuresRes.data || null) as DataRow | null,
    subscription: (subscriptionRes.data || null) as DataRow | null,
    users: (usersRes.data || []) as DataRow[],
    orders: (ordersRes.data || []) as DataRow[],
    payments: (paymentEventsRes.data || []) as DataRow[],
    terminals: (terminalsRes.data || []) as DataRow[],
    tables: (tablesRes.data || []) as DataRow[],
    audits: (auditsRes.data || []) as DataRow[],
    menuCounts: { categories: categoriesRes.count || 0, items: itemsRes.count || 0 },
    receipts: receiptsRes.error ? [] : ((receiptsRes.data || []) as DataRow[]),
  }
}

export default async function RestaurantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const data = await loadRestaurant(id)
  if (!data) notFound()

  const {
    restaurant,
    ownerEmail,
    features,
    subscription,
    users,
    orders,
    payments,
    terminals,
    tables,
    audits,
    menuCounts,
    receipts,
    loadedAt,
  } = data
  const requestedTab = String(query.tab || '').toLowerCase()
  const defaultTab: TabKey = TAB_KEYS.includes(requestedTab as TabKey)
    ? (requestedTab as TabKey)
    : 'overview'
  const activeTerminals = terminals.filter(
    (terminal) => terminal.active && terminal.status === 'active',
  )
  const onlineTerminals = activeTerminals.filter(
    (terminal) =>
      terminal.last_seen_at &&
      loadedAt - new Date(String(terminal.last_seen_at)).getTime() < 15 * 60 * 1000,
  )
  const health = !restaurant.is_active
    ? 'unknown'
    : onlineTerminals.length < activeTerminals.length
      ? 'critical'
      : 'ok'

  const timeline = buildRestaurantTimeline({
    terminals,
    orders,
    payments,
    receipts,
    audits,
    loadedAt,
  })

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/restaurants" className="text-sm font-medium text-[#C0392B] hover:underline">
          ← Restaurants
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            {String(restaurant.name)}
          </h1>
          <HealthBadge status={health} />
          <StatusBadge value={restaurant.is_active ? 'active' : 'inactive'} />
        </div>
        <p className="mt-1 font-mono text-xs text-[#8A867C]">{id}</p>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-5">
        <div className="overflow-x-auto border-b border-[#E8E6E1]">
          <TabsList className="h-auto min-w-max justify-start rounded-none bg-transparent p-0">
            {TAB_KEYS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className="rounded-none border-b-2 border-transparent px-3 py-2.5 capitalize text-[#8A867C] shadow-none data-[state=active]:border-[#C0392B] data-[state=active]:bg-transparent data-[state=active]:text-[#1A1A1A] data-[state=active]:shadow-none"
              >
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Restaurant">
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ['Name', restaurant.name],
                  ['Slug', restaurant.slug],
                  ['Owner email', ownerEmail],
                  ['Phone', restaurant.phone],
                  ['Address', restaurant.address],
                  ['Currency', restaurant.currency],
                  ['Timezone', restaurant.timezone],
                  ['Created', formatDate(restaurant.created_at)],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-xs text-[#8A867C]">{String(label)}</dt>
                    <dd className="mt-1 text-sm font-medium text-[#1A1A1A]">
                      {value ? String(value) : '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
            <Card title="Health & subscription">
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-[#8A867C]">Fleet health</dt>
                  <dd className="mt-1">
                    <HealthBadge status={health} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#8A867C]">Terminals online</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {onlineTerminals.length} / {activeTerminals.length}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#8A867C]">Plan</dt>
                  <dd className="mt-1 capitalize">{String(subscription?.plan || '—')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[#8A867C]">Subscription status</dt>
                  <dd className="mt-1">
                    {subscription ? <StatusBadge value={subscription.status} /> : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#8A867C]">Renews</dt>
                  <dd className="mt-1 text-sm">{formatDate(subscription?.renews_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[#8A867C]">Online ordering</dt>
                  <dd className="mt-1 text-sm">
                    {restaurant.online_ordering_enabled ? 'Enabled' : 'Disabled'}
                  </dd>
                </div>
              </dl>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="timeline">
          {timeline.length === 0 ? (
            <EmptyState
              title="No timeline events"
              body="Operational events for this restaurant will appear here as terminals, payments, receipts, and audits occur."
            />
          ) : (
            <Card
              title="Restaurant timeline"
              description="Unified sequence for support troubleshooting — terminals, payments, receipts, and audits."
            >
              <ol className="relative space-y-0 border-l border-[#E8E6E1] ml-2">
                {timeline.map((event) => {
                  const time = new Date(event.at)
                  const clock = time.toLocaleTimeString('en-NA', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })
                  return (
                    <li key={event.id} className="relative pb-5 pl-6 last:pb-0">
                      <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#C4C0B6]" />
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <time className="font-mono text-[12px] font-semibold tabular-nums text-[#8A867C]">
                          {clock}
                        </time>
                        <span className="text-sm font-medium text-[#1A1A1A]">{event.label}</span>
                      </div>
                      {event.detail ? (
                        <p className="mt-0.5 text-[12px] text-[#8A867C]">{event.detail}</p>
                      ) : null}
                      <p className="mt-0.5 text-[11px] text-[#C4C0B6]">{formatDate(event.at)}</p>
                    </li>
                  )
                })}
              </ol>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="users">
          {users.length === 0 ? (
            <EmptyState title="No users" body="No users are assigned to this restaurant." />
          ) : (
            <Card title="Users" description={`${users.length} assigned users`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs text-[#8A867C]">
                    <tr><th className="pb-3">Email</th><th className="pb-3">Role</th><th className="pb-3">Joined</th><th className="pb-3">Invite</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#EFEDE8]">
                    {users.map((user) => (
                      <tr key={String(user.id)}>
                        <td className="py-3 font-medium">{String(relationValue(user.users)?.email || user.user_id)}</td>
                        <td className="py-3"><StatusBadge value={user.role} /></td>
                        <td className="py-3 text-[#8A867C]">{formatDate(user.created_at)}</td>
                        <td className="py-3 text-[#5C574E]">{user.invite_accepted ? 'Accepted' : 'Pending'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="menus">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Categories"><div className="text-3xl font-semibold">{menuCounts.categories}</div></Card>
            <Card title="Menu items"><div className="text-3xl font-semibold">{menuCounts.items}</div></Card>
          </div>
        </TabsContent>

        <TabsContent value="orders">
          {orders.length === 0 ? (
            <EmptyState title="No orders" body="This restaurant has no recent orders." />
          ) : (
            <Card title="Recent orders" description="Latest 50">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-xs text-[#8A867C]"><tr><th className="pb-3">Order</th><th className="pb-3">Channel</th><th className="pb-3">Order status</th><th className="pb-3">Payment</th><th className="pb-3 text-right">Total</th><th className="pb-3 text-right">Placed</th></tr></thead>
                  <tbody className="divide-y divide-[#EFEDE8]">
                    {orders.map((order) => (
                      <tr key={String(order.id)}>
                        <td className="py-3 font-medium">#{String(order.order_number || order.id)}</td>
                        <td className="py-3 capitalize text-[#5C574E]">{String(order.channel || 'table')}</td>
                        <td className="py-3"><StatusBadge value={order.status} /></td>
                        <td className="py-3"><StatusBadge value={order.payment_status} /></td>
                        <td className="py-3 text-right font-medium">{money(order.total)}</td>
                        <td className="py-3 text-right text-[#8A867C]">{formatDate(order.placed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="payments">
          {payments.length === 0 ? (
            <EmptyState title="No payment events" body="No gateway events are recorded for this restaurant." />
          ) : (
            <Card title="Payment events" description="Latest 50">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-sm">
                  <thead className="text-xs text-[#8A867C]"><tr><th className="pb-3">Reference</th><th className="pb-3">Event</th><th className="pb-3">Result</th><th className="pb-3 text-right">Amount</th><th className="pb-3 text-right">Time</th></tr></thead>
                  <tbody className="divide-y divide-[#EFEDE8]">
                    {payments.map((payment) => (
                      <tr key={String(payment.id)}>
                        <td className="py-3 font-mono text-xs">{String(payment.business_order_no || payment.order_ids || '—')}</td>
                        <td className="py-3"><StatusBadge value={payment.event_type} /></td>
                        <td className="max-w-xs truncate py-3 text-[#5C574E]">{String(payment.gateway_result_message || payment.gateway_result_code || '—')}</td>
                        <td className="py-3 text-right font-medium">{money(payment.amount)}</td>
                        <td className="py-3 text-right text-[#8A867C]">{formatDate(payment.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="receipts">
          {receipts.length === 0 ? (
            <EmptyState title="No receipts" body="No receipt documents are available for this restaurant." />
          ) : (
            <Card title="Receipts" description="Latest 50 documents">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead className="text-xs text-[#8A867C]"><tr><th className="pb-3">Document</th><th className="pb-3">Order</th><th className="pb-3">Type</th><th className="pb-3">Status</th><th className="pb-3 text-right">Issued</th></tr></thead>
                  <tbody className="divide-y divide-[#EFEDE8]">
                    {receipts.map((receipt) => (
                      <tr key={String(receipt.id)}>
                        <td className="py-3 font-medium">{String(receipt.document_number || receipt.id)}</td>
                        <td className="py-3 font-mono text-xs">{String(receipt.order_id || '—')}</td>
                        <td className="py-3 text-[#5C574E]">{String(receipt.document_type || '—')}</td>
                        <td className="py-3"><StatusBadge value={receipt.status} /></td>
                        <td className="py-3 text-right text-[#8A867C]">{formatDate(receipt.issued_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="terminals">
          {terminals.length === 0 ? (
            <EmptyState title="No terminals" body="No devices are registered to this restaurant." />
          ) : (
              <>
            <Card title="Kitchen and bar screens">
                <VenueStationScreens
                  screens={terminals
                    .filter((t) => t.station_kind === 'kitchen' || t.station_kind === 'bar')
                    .map((t): VenueStationScreen => ({
                      id: String(t.id),
                      stationKind: t.station_kind as 'kitchen' | 'bar',
                      name: t.terminal_name ? String(t.terminal_name) : null,
                      status: t.status ? String(t.status) : null,
                      active: Boolean(t.active),
                      lastSeenAt: t.last_seen_at ? String(t.last_seen_at) : null,
                      activatedAt: t.activated_at ? String(t.activated_at) : null,
                    }))}
                  now={loadedAt}
                />
              </Card>

              <Card title="Terminals">
              <div className="grid gap-3 md:grid-cols-2">
                {terminals.map((terminal) => {
                  const online = Boolean(
                    terminal.active &&
                      terminal.status === 'active' &&
                      terminal.last_seen_at &&
                      loadedAt - new Date(String(terminal.last_seen_at)).getTime() < 15 * 60 * 1000,
                  )
                  return (
                    <Link key={String(terminal.id)} href={`/admin/terminals/${String(terminal.id)}`} className="rounded-lg border border-[#E8E6E1] p-4 hover:bg-[#FAFAF8]">
                      <div className="flex items-start justify-between gap-3">
                        <div><div className="font-medium">{String(terminal.terminal_name || terminal.name || terminal.sn || 'Terminal')}</div><div className="mt-1 text-xs text-[#8A867C]">{String(terminal.app_version || 'Version unknown')} · {formatDate(terminal.last_seen_at)}</div></div>
                        <HealthBadge status={online ? 'online' : 'offline'} />
                      </div>
                    </Link>
                  )
                })}
              </div>
            </Card>
              </>
          )}
        </TabsContent>

        <TabsContent value="tables">
          {tables.length === 0 ? (
            <EmptyState title="No tables" body="No restaurant tables are configured." />
          ) : (
            <Card title="Tables">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tables.map((table) => (
                  <div key={String(table.id)} className="rounded-lg border border-[#E8E6E1] p-4">
                    <div className="flex items-center justify-between"><span className="font-medium">{String(table.table_name || `Table ${table.table_number}`)}</span><StatusBadge value={table.status} /></div>
                    <div className="mt-2 text-xs text-[#8A867C]">{table.is_kiosk ? 'Kiosk' : 'Dining table'} · {table.active ? 'Active' : 'Inactive'}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="integrations">
          <Card title="Finatic / PayCloud" description="Merchant gateway identifiers">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Merchant number', restaurant.finatic_merchant_no || restaurant.checkout_merchant_no],
                ['Store number', restaurant.finatic_store_no || restaurant.checkout_store_no],
                ['Terminal serial', restaurant.finatic_terminal_sn],
              ].map(([label, value]) => (
                <div key={String(label)}><dt className="text-xs text-[#8A867C]">{String(label)}</dt><dd className="mt-1 break-all font-mono text-sm">{value ? String(value) : 'Not configured'}</dd></div>
              ))}
            </dl>
          </Card>
        </TabsContent>

        <TabsContent value="billing">
          {subscription ? (
            <Card title="Subscription">
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ['Plan', subscription.plan],
                  ['Status', subscription.status],
                  ['Trial ends', formatDate(subscription.trial_ends_at)],
                  ['Renews', formatDate(subscription.renews_at)],
                ].map(([label, value]) => (
                  <div key={String(label)}><dt className="text-xs text-[#8A867C]">{String(label)}</dt><dd className="mt-1 text-sm font-medium capitalize">{value ? String(value) : '—'}</dd></div>
                ))}
              </dl>
            </Card>
          ) : (
            <EmptyState title="No subscription" body="No billing subscription is attached to this restaurant." />
          )}
        </TabsContent>

        <TabsContent value="audit">
          {audits.length === 0 ? (
            <EmptyState title="No audit history" body="No tenant audit events are recorded." />
          ) : (
            <Card title="Audit history" description="Latest 100 tenant events">
              <ul className="divide-y divide-[#EFEDE8]">
                {audits.map((audit) => (
                  <li key={String(audit.id)} className="flex flex-col justify-between gap-1 py-3 sm:flex-row sm:items-center">
                    <div><div className="text-sm font-medium">{String(audit.action)}</div><div className="text-xs text-[#8A867C]">{String(audit.entity_type || 'restaurant')} {String(audit.entity_id || '')}</div></div>
                    <time className="text-xs text-[#8A867C]">{formatDate(audit.created_at)}</time>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="settings">
          <Card title="Feature flags" description="Enable or disable product capabilities for this restaurant.">
            <FeatureFlagsPanel restaurantId={id} initialFeatures={normalizeFeatures(features)} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
