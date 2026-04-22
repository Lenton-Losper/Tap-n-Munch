import { NextResponse } from 'next/server'
import { createSupabaseUser } from '@/lib/supabase/users'
import { createSupabaseRestaurant } from '@/lib/supabase/restaurants'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      id,
      email,
      name,
      phone,
      role,
      restaurantName,
    } = body ?? {}

    if (!id || !email || !restaurantName) {
      return NextResponse.json(
        { error: 'Missing required fields: id, email, restaurantName' },
        { status: 400 }
      )
    }

    await createSupabaseUser({
      id,
      email,
      name: name || `${restaurantName} Owner`,
      phone: phone || '',
      role: role || 'owner',
    })

    const restaurant = await createSupabaseRestaurant({
      owner_id: id,
      name: restaurantName,
      phone: phone || '',
      currency: 'NAD',
    })

    return NextResponse.json({
      ok: true,
      userId: id,
      restaurantId: restaurant?.id ?? null,
    })
  } catch (error: any) {
    console.error('Supabase signup sync failed:', error)
    return NextResponse.json(
      { error: error?.message || 'Supabase signup sync failed' },
      { status: 500 }
    )
  }
}
