import Link from 'next/link'
import { cookies, headers } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export const dynamic = 'force-dynamic'

type RestaurantFeatures = {
  kiosk_enabled?: boolean
  staff_app_enabled?: boolean
}

type RestaurantRow = {
  id: string
  name: string
  slug?: string | null
  owner_email?: string | null
  created_at: string
  features: RestaurantFeatures | null
  subscription: { plan: string; status: string } | null
}

const FEATURE_BADGES: { key: keyof RestaurantFeatures; label: string }[] = [
  { key: 'kiosk_enabled', label: 'kiosk' },
  { key: 'staff_app_enabled', label: 'staff_app' },
]

function getBaseUrl(host: string | null): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '')
  if (configured) return configured
  if (!host) return 'http://localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  return `${protocol}://${host}`
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
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )

  const { data: { user }, error: userError } = await supabase.auth.getUser()

  if (userError || !user) {
    return { restaurants: [], failed: true }
  }

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) {
    return { restaurants: [], failed: true }
  }

  const host = (await headers()).get('host')
  const baseUrl = getBaseUrl(host)

  try {
    const res = await fetch(`${baseUrl}/api/platform/restaurants`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    })

    if (!res.ok) {
      return { restaurants: [], failed: true }
    }

    const data = (await res.json()) as { restaurants?: RestaurantRow[] }
    return { restaurants: data.restaurants ?? [], failed: false }
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
        <div className="mx-auto max-w-7xl">
          <h1 className="font-serif text-3xl font-semibold text-[#37352F]">
            Platform {'\u2014'} Restaurants
          </h1>
          <p className="mt-1 text-sm text-[#6B675F]">
            {failed
              ? 'Unable to load restaurants.'
              : `${restaurants.length} restaurant${restaurants.length === 1 ? '' : 's'} on the platform`}
          </p>
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
                    <th className="px-4 py-3 font-medium">Features</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {restaurants.map((restaurant) => {
                    const badges = enabledFeatureBadges(restaurant.features)
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
