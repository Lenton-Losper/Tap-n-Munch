import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, terminal_name, device_serial, model, status, activation_code, activation_code_expires_at')
      .eq('restaurant_id', restaurantId)
      .in('status', ['active', 'inactive'])
      .order('created_at', { ascending: false })

    if (error) throw error
    return NextResponse.json({ terminals: data || [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load terminals'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
