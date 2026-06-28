import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = createServerSupabaseClient()
    const [restaurantRes, featuresRes, subRes] = await Promise.all([
      supabase.from('restaurants').select('id, name, created_at').eq('id', params.id).maybeSingle(),
      supabase.from('restaurant_features').select('*').eq('restaurant_id', params.id).maybeSingle(),
      supabase.from('subscriptions').select('plan, status, trial_ends_at, renews_at').eq('restaurant_id', params.id).maybeSingle(),
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
