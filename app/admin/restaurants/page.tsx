import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { EmptyState, HealthBadge } from '@/components/platform/ops-shell'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type RestaurantFleetRow = {
  id: string
  name: string
  created_at: string
  is_active: boolean
  online: number
  terminals: number
  last_paid_at: string | null
  subscription: { plan?: string; status?: string } | null
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return includeTime
    ? date.toLocaleString('en-NA', { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString('en-NA', { year: 'numeric', month: 'short', day: 'numeric' })
}

async function loadFleet(): Promise<{ rows: RestaurantFleetRow[]; error: string | null }> {
  try {
    const supabase = createServerSupabaseClient()
    const { data: restaurants, error } = await supabase
      .from('restaurants')
      .select('id, name, created_at, is_active')
      .is('deleted_at', null)
      .order('name')

    if (error) throw error
    const ids = (restaurants || []).map((restaurant) => restaurant.id)
    if (ids.length === 0) return { rows: [], error: null }

    const [terminalsRes, ordersRes, subscriptionsRes] = await Promise.all([
      supabase
        .from('restaurant_terminals')
        .select('id, restaurant_id, active, status, last_seen_at')
        .in('restaurant_id', ids),
      supabase
        .from('orders')
        .select('restaurant_id, paid_at')
        .in('restaurant_id', ids)
        .eq('payment_status', 'paid')
        .not('paid_at', 'is', null)
        .order('paid_at', { ascending: false })
        .limit(5000),
      supabase.from('subscriptions').select('restaurant_id, plan, status').in('restaurant_id', ids),
    ])

    const cutoff = Date.now() - 15 * 60 * 1000
    const terminalCounts = new Map<string, { online: number; total: number }>()
    for (const terminal of terminalsRes.data || []) {
      if (!terminal.active || terminal.status !== 'active') continue
      const count = terminalCounts.get(terminal.restaurant_id) || { online: 0, total: 0 }
      count.total += 1
      if (terminal.last_seen_at && new Date(terminal.last_seen_at).getTime() >= cutoff) {
        count.online += 1
      }
      terminalCounts.set(terminal.restaurant_id, count)
    }

    const lastPaid = new Map<string, string>()
    for (const order of ordersRes.data || []) {
      if (order.paid_at && !lastPaid.has(order.restaurant_id)) {
        lastPaid.set(order.restaurant_id, order.paid_at)
      }
    }

    const subscriptions = new Map(
      (subscriptionsRes.data || []).map((subscription) => [
        subscription.restaurant_id,
        { plan: subscription.plan, status: subscription.status },
      ]),
    )

    return {
      rows: (restaurants || []).map((restaurant) => {
        const counts = terminalCounts.get(restaurant.id) || { online: 0, total: 0 }
        return {
          id: restaurant.id,
          name: restaurant.name,
          created_at: restaurant.created_at,
          is_active: Boolean(restaurant.is_active),
          online: counts.online,
          terminals: counts.total,
          last_paid_at: lastPaid.get(restaurant.id) || null,
          subscription: subscriptions.get(restaurant.id) || null,
        }
      }),
      error: null,
    }
  } catch (cause) {
    console.error('[admin/restaurants] Failed to load fleet', cause)
    return { rows: [], error: 'The restaurant fleet could not be loaded.' }
  }
}

export default async function RestaurantsPage() {
  const { rows, error } = await loadFleet()

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Restaurants</h1>
          <p className="mt-1 text-sm text-[#8A867C]">
            {error || `${rows.length} restaurants · terminal health updates after 15 minutes`}
          </p>
        </div>
        <Link
          href="/admin/settings/admins"
          className="text-sm font-medium text-[#C0392B] hover:underline"
        >
          Platform admins →
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={error ? 'Fleet unavailable' : 'No restaurants'}
          body={error || 'Restaurants will appear here after onboarding.'}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-[#E8E6E1] bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Health</th>
                  <th className="px-4 py-3 font-semibold">Terminals online / total</th>
                  <th className="px-4 py-3 font-semibold">Last activity</th>
                  <th className="px-4 py-3 font-semibold">Subscription</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {rows.map((restaurant) => {
                  const health = !restaurant.is_active
                    ? 'unknown'
                    : restaurant.online < restaurant.terminals
                      ? 'critical'
                      : 'ok'
                  return (
                    <tr key={restaurant.id} className="hover:bg-[#FAFAF8]">
                      <td className="px-4 py-3 font-medium text-[#1A1A1A]">
                        <Link href={`/admin/restaurants/${restaurant.id}`} className="hover:underline">
                          {restaurant.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <HealthBadge status={health} />
                      </td>
                      <td className="px-4 py-3 text-[#5C574E]">
                        <span className="font-medium text-[#1A1A1A]">{restaurant.online}</span>
                        {' / '}
                        {restaurant.terminals}
                      </td>
                      <td className="px-4 py-3 text-[#5C574E]">
                        {formatDate(restaurant.last_paid_at, true)}
                      </td>
                      <td className="px-4 py-3">
                        {restaurant.subscription ? (
                          <div className="flex items-center gap-2">
                            <span className="capitalize text-[#1A1A1A]">
                              {restaurant.subscription.plan || 'Plan'}
                            </span>
                            <Badge
                              variant="outline"
                              className="border-[#E8E6E1] text-[#8A867C]"
                            >
                              {restaurant.subscription.status || 'unknown'}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-[#8A867C]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#8A867C]">
                        {formatDate(restaurant.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/admin/restaurants/${restaurant.id}`}
                          className="font-medium text-[#C0392B] hover:underline"
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
