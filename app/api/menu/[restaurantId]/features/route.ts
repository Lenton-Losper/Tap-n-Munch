import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: { restaurantId: string } }
) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: features } = await supabase
      .from('restaurant_features')
      .select('*')
      .eq('restaurant_id', params.restaurantId)
      .maybeSingle()

    return NextResponse.json({ features: features ?? null })
  } catch (err) {
    console.error('[menu/features] GET error:', err)
    return NextResponse.json({ features: null })
  }
}
