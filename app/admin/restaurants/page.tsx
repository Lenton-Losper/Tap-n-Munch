import Link from 'next/link'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type RestaurantFeatures = {
  kiosk_enabled?: boolean
  staff_app_enabled?: boolean
  whatsapp_enabled?: boolean
}

type RestaurantRow = {
  id: string
  name: string
  slug?: string | null
  owner_email?: string | null
  created_at: string
  is_active: boolean
  online_ordering_enabled: boolean
  features: RestaurantFeatures | null
  subscription: { plan: string; status: string } | null
}

const FEATURE_BADGES: { key: keyof RestaurantFeatures; label: string }[] = [
  { key: 'kiosk_enabled', label: 'kiosk' },
  { key: 'staff_app_enabled', label: 'staff_app' },
]

function orderingChannels(restaurant: Pick<RestaurantRow, 'online_ordering_enabled' | 'features'>): string[] {
  const channels = ['Table']
  if (restaurant.features?.kiosk_enabled) channels.push('Kiosk')
  if (restaurant.online_ordering_enabled) channels.push('Online')
  if (restaurant.features?.whatsapp_enabled) channels.push('WhatsApp')
  return channels
}

function formatDate(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-NA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function enabledFeatureBadges(features: RestaurantFeatures | null): string[] {
  if (!features) return []
  return FEATURE_BADGES.filter(({ key }) => features[key]).map(({ label }) => label)
}

async function loadRestaurants(): Promise<{ restaurants: RestaurantRow[]; failed: boolean }> {
  try {
    const supabase = createServerSupabaseClient()

    const { data: restaurants, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, created_at, is_active, online_ordering_enabled')
      .order('created_at', { ascending: false })

    if (error) throw error
    if (!restaurants) return { restaurants: [], failed: false }

    const restaurantIds = restaurants.map((r) => r.id)
    const ownerEmails = new Map<string, string>()

    if (restaurantIds.length > 0) {
      const { data: ownerRows } = await supabase
        .from('restaurant_users')
        .select('restaurant_id, user_id, users!restaurant_users_user_id_fkey(email)')
        .in('restaurant_id', restaurantIds)
        .eq('role', 'owner')
        .is('deleted_at', null)

      for (const row of ownerRows ?? []) {
        const usersRelation = row.users as { email: string } | { email: string }[] | null
        const email = Array.isArray(usersRelation) ? usersRelation[0]?.email : usersRelation?.email
        if (email && !ownerEmails.has(row.restaurant_id)) {
          ownerEmails.set(row.restaurant_id, email)
        }
      }
    }

    const results = await Promise.all(
      restaurants.map(async (r) => {
        const [featuresRes, subRes] = await Promise.all([
          supabase
            .from('restaurant_features')
            .select('kiosk_enabled, staff_app_enabled, whatsapp_enabled')
            .eq('restaurant_id', r.id)
            .maybeSingle(),
          supabase
            .from('subscriptions')
            .select('plan, status')
            .eq('restaurant_id', r.id)
            .maybeSingle(),
        ])
        return {
          id: r.id,
          name: r.name,
          slug: r.slug ?? null,
          owner_email: ownerEmails.get(r.id) ?? null,
          created_at: r.created_at,
          is_active: Boolean(r.is_active),
          online_ordering_enabled: Boolean(r.online_ordering_enabled),
          features: featuresRes.data,
          subscription: subRes.data,
        }
      })
    )

    return { restaurants: results, failed: false }
  } catch {
    return { restaurants: [], failed: true }
  }
}

export default async function AdminRestaurantsPage() {
  const { restaurants, failed } = await loadRestaurants()
  const showEmpty = failed || restaurants.length === 0

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-start justify-between">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">
              Platform {'\u2014'} Restaurants
            </h1>
            <p className="mt-1 text-sm text-[#6B675F]">
              {failed
                ? 'Unable to load restaurants.'
                : `${restaurants.length} restaurant${restaurants.length === 1 ? '' : 's'} on the platform`}
            </p>
          </div>
          <Link
            href="/admin/platform-admins"
            className="text-sm font-medium text-[#2E75B6] hover:underline"
          >
            Platform Admins {'\u2192'}
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {showEmpty ? (
          <div className="rounded-2xl border border-[#E9E9E7] bg-white px-6 py-16 text-center">
            <p className="text-lg font-medium text-[#37352F]">No restaurants to show</p>
            <p className="mt-2 text-sm text-[#6B675F]">
              {failed
                ? 'The restaurant list could not be loaded. Try refreshing the page.'
                : 'No restaurants have been created yet.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[#E9E9E7] bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[#E9E9E7] bg-[#FAFAF8] text-xs uppercase tracking-wide text-[#6B675F]">
                  <tr>
                    <th className="px-4 py-3 font-medium">Restaurant Name</th>
                    <th className="px-4 py-3 font-medium">Slug</th>
                    <th className="px-4 py-3 font-medium">Owner Email</th>
                    <th className="px-4 py-3 font-medium">Created Date</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Ordering Channels</th>
                    <th className="px-4 py-3 font-medium">Features</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {restaurants.map((restaurant) => {
                    const badges = enabledFeatureBadges(restaurant.features)
                    const channels = orderingChannels(restaurant)
                    return (
                      <tr
                        key={restaurant.id}
                        className="border-b border-[#F1F0EC] last:border-0"
                      >
                        <td className="px-4 py-3 font-medium text-[#37352F]">
                          {restaurant.name}
                        </td>
                        <td className="px-4 py-3 text-[#6B675F]">
                          {restaurant.slug ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#6B675F]">
                          {restaurant.owner_email ?? '—'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-[#37352F]">
                          {formatDate(restaurant.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              restaurant.is_active
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {restaurant.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[#6B675F]">
                          {channels.join(', ')}
                        </td>
                        <td className="px-4 py-3">
                          {badges.length === 0 ? (
                            <span className="text-[#6B675F]">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {badges.map((label) => (
                                <span
                                  key={label}
                                  className="inline-flex items-center rounded-full bg-[#EBF3FB] px-2.5 py-0.5 text-xs font-medium text-[#2E75B6]"
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/admin/restaurants/${restaurant.id}`}
                            className="text-sm font-medium text-[#2E75B6] hover:underline"
                          >
                            Manage
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
    </div>
  )
}
