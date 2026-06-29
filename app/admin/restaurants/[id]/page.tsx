import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import {
  FEATURE_FLAG_KEYS,
  FeatureFlagsPanel,
  type FeatureFlagsState,
} from './feature-flags-panel'

export const dynamic = 'force-dynamic'

type RestaurantDetail = {
  id: string
  name: string
  slug: string | null
  owner_email: string | null
  created_at: string
}

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

function normalizeFeatures(raw: Record<string, unknown> | null | undefined): FeatureFlagsState {
  return FEATURE_FLAG_KEYS.reduce((acc, key) => {
    acc[key] = Boolean(raw?.[key])
    return acc
  }, {} as FeatureFlagsState)
}

async function loadRestaurant(id: string) {
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

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return null

  const host = (await headers()).get('host')
  const baseUrl = getBaseUrl(host)

  const res = await fetch(`${baseUrl}/api/platform/restaurants/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  })

  if (!res.ok) return null

  return res.json() as Promise<{
    restaurant: RestaurantDetail | null
    features: Record<string, unknown> | null
    subscription: { plan: string; status: string } | null
  }>
}

export default async function AdminRestaurantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await loadRestaurant(id)

  if (!data?.restaurant) {
    notFound()
  }

  const { restaurant, features, subscription } = data
  const featureState = normalizeFeatures(features)

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/admin/restaurants"
            className="text-sm font-medium text-[#2E75B6] hover:underline"
          >
            ← Back to restaurants
          </Link>
          <h1 className="mt-4 font-serif text-3xl font-semibold text-[#37352F]">
            {restaurant.name}
          </h1>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[#6B675F]">Slug</dt>
              <dd className="font-medium text-[#37352F]">{restaurant.slug ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[#6B675F]">Owner email</dt>
              <dd className="font-medium text-[#37352F]">{restaurant.owner_email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[#6B675F]">Created</dt>
              <dd className="font-medium text-[#37352F]">{formatDate(restaurant.created_at)}</dd>
            </div>
            {subscription && (
              <div>
                <dt className="text-[#6B675F]">Subscription</dt>
                <dd className="font-medium text-[#37352F]">
                  {subscription.plan} · {subscription.status}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-[#37352F]">Feature Flags</h2>
          <p className="mt-1 text-sm text-[#6B675F]">
            Enable or disable product features for this restaurant.
          </p>
          <div className="mt-6">
            <FeatureFlagsPanel restaurantId={id} initialFeatures={featureState} />
          </div>
        </div>
      </div>
    </div>
  )
}
