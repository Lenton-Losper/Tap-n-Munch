import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { FEATURE_FLAG_KEYS, type FeatureFlagsState } from './constants'
import { FeatureFlagsPanel } from './feature-flags-panel'

export const dynamic = 'force-dynamic'

const FEATURE_COLUMNS =
  'kitchen_enabled, inventory_enabled, analytics_enabled, split_bill_enabled, reservations_enabled, loyalty_enabled, online_payments_enabled, multi_branch_enabled, staff_app_enabled, kiosk_enabled, whatsapp_enabled'

type RestaurantDetail = {
  id: string
  name: string
  slug: string | null
  owner_email: string | null
  created_at: string
  is_active: boolean
  online_ordering_enabled: boolean
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

async function loadRestaurant(id: string): Promise<{
  restaurant: RestaurantDetail | null
  features: Record<string, unknown> | null
  subscription: { plan: string; status: string } | null
} | null> {
  try {
    const supabase = createServerSupabaseClient()
    const [restaurantRes, featuresRes, subRes] = await Promise.all([
      supabase
        .from('restaurants')
        .select('id, name, slug, created_at, owner_id, is_active, online_ordering_enabled')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('restaurant_features')
        .select(FEATURE_COLUMNS)
        .eq('restaurant_id', id)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('plan, status, trial_ends_at, renews_at')
        .eq('restaurant_id', id)
        .maybeSingle(),
    ])

    let ownerEmail: string | null = null
    if (restaurantRes.data?.owner_id) {
      const { data: owner } = await supabase
        .from('users')
        .select('email')
        .eq('id', restaurantRes.data.owner_id)
        .maybeSingle()
      ownerEmail = owner?.email ? String(owner.email) : null
    }

    const restaurant = restaurantRes.data
      ? {
          id: restaurantRes.data.id,
          name: restaurantRes.data.name,
          slug: restaurantRes.data.slug ?? null,
          owner_email: ownerEmail,
          created_at: restaurantRes.data.created_at,
          is_active: Boolean(restaurantRes.data.is_active),
          online_ordering_enabled: Boolean(restaurantRes.data.online_ordering_enabled),
        }
      : null

    return {
      restaurant,
      features: featuresRes.data,
      subscription: subRes.data,
    }
  } catch {
    return null
  }
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
            <div>
              <dt className="text-[#6B675F]">Status</dt>
              <dd className="font-medium text-[#37352F]">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    restaurant.is_active
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {restaurant.is_active ? 'Active' : 'Inactive'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-[#6B675F]">Ordering Channels</dt>
              <dd className="font-medium text-[#37352F]">
                {['Table', ...(featureState.kiosk_enabled ? ['Kiosk'] : []), ...(restaurant.online_ordering_enabled ? ['Online'] : []), ...(featureState.whatsapp_enabled ? ['WhatsApp'] : [])].join(', ')}
              </dd>
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

        <div className="mt-6 rounded-2xl border border-dashed border-[#E9E9E7] bg-white p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-[#37352F]">Connections</h2>
          <p className="mt-1 text-sm text-[#6B675F]">
            {/* TODO(#13 follow-up): WhatsApp/Connections management depends on a tenancy-model
                decision not yet made (design note section 2.8). Intentionally out of scope
                for this pass -- do not build WhatsApp-specific UI here until that's resolved. */}
            Not yet available — pending a tenancy-model decision.
          </p>
        </div>
      </div>
    </div>
  )
}
