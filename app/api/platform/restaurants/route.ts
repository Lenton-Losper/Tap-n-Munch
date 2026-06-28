import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const supabase = createServerSupabaseClient()

    // TODO: add platform_admins auth check here
    const { data: restaurants } = await supabase
      .from('restaurants')
      .select('id, name, created_at')
      .order('created_at', { ascending: false })

    if (!restaurants) return NextResponse.json({ restaurants: [] })

    const results = await Promise.all(
      restaurants.map(async r => {
        const [featuresRes, subRes] = await Promise.all([
          supabase.from('restaurant_features').select('kiosk_enabled, staff_app_enabled').eq('restaurant_id', r.id).maybeSingle(),
          supabase.from('subscriptions').select('plan, status').eq('restaurant_id', r.id).maybeSingle(),
        ])
        return { ...r, features: featuresRes.data, subscription: subRes.data }
      })
    )

    return NextResponse.json({ restaurants: results })
  } catch (err) {
    console.error('[platform/restaurants] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
