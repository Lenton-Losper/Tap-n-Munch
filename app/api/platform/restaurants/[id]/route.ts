import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertPlatformAdmin } from '@/lib/permissions/assert-platform-admin'

export const dynamic = 'force-dynamic'

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
      supabase.from('restaurants').select('id, name, created_at').eq('id', id).maybeSingle(),
      supabase.from('restaurant_features').select('*').eq('restaurant_id', id).maybeSingle(),
      supabase.from('subscriptions').select('plan, status, trial_ends_at, renews_at').eq('restaurant_id', id).maybeSingle(),
    ])
    return NextResponse.json({
      restaurant: restaurantRes.data,
      features: featuresRes.data,
      subscription: subRes.data,
    })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
