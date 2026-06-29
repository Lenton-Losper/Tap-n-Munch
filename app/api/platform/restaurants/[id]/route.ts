import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertPlatformAdmin } from '@/lib/permissions/assert-platform-admin'

export const dynamic = 'force-dynamic'

const FEATURE_COLUMNS =
  'kitchen_enabled, inventory_enabled, analytics_enabled, split_bill_enabled, reservations_enabled, loyalty_enabled, online_payments_enabled, multi_branch_enabled, staff_app_enabled, kiosk_enabled, whatsapp_enabled'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await assertPlatformAdmin(request)
  if (denied) return denied

  const { id } = await params
  try {
    const supabase = createServerSupabaseClient()
    const [restaurantRes, featuresRes, subRes] = await Promise.all([
      supabase
        .from('restaurants')
        .select('id, name, slug, created_at, owner_id')
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
        }
      : null

    return NextResponse.json({
      restaurant,
      features: featuresRes.data,
      subscription: subRes.data,
    })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
