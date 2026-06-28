import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    if (!restaurantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [featuresRes, subRes] = await Promise.all([
      supabase.from('restaurant_features').select('*').eq('restaurant_id', restaurantId).maybeSingle(),
      supabase.from('subscriptions').select('plan, status, trial_ends_at, renews_at').eq('restaurant_id', restaurantId).maybeSingle(),
    ])

    return NextResponse.json({
      features: featuresRes.data ?? null,
      subscription: subRes.data ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message.includes('Missing authorization') || message.includes('Invalid or expired session')) {
      return NextResponse.json({ error: message }, { status: 401 })
    }
    console.error('[admin/features] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
