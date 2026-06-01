import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function resolveRestaurantId(supabase: ReturnType<typeof createServerSupabaseClient>, input: string) {
  if (isUuid(input)) return input

  const { data, error } = await supabase
    .from('restaurants')
    .select('id')
    .eq('firebase_restaurant_id', input)
    .maybeSingle()

  if (error) throw error
  if (!data?.id) throw new Error('Restaurant not found')
  return data.id as string
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { restaurantId?: string; updates?: Record<string, any> }
    const restaurantId = String(body?.restaurantId || '').trim()
    const updates = body?.updates || {}

    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const resolvedRestaurantId = await resolveRestaurantId(supabase, restaurantId)
    const { data, error } = await supabase
      .from('restaurants')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', resolvedRestaurantId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Failed to update restaurant settings' },
      { status: 500 }
    )
  }
}
