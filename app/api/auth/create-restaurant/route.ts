import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Failed to create restaurant'
}

export async function POST(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const body = await request.json()
    const restaurantName = String(body?.restaurantName || '').trim()
    const fullName = String(body?.fullName || '').trim()
    const phone = String(body?.phone || '').trim()

    if (!restaurantName || !fullName) {
      return NextResponse.json(
        { error: 'Missing required fields: restaurantName, fullName' },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()

    const { data: existingMembership } = await supabase
      .from('restaurant_users')
      .select('restaurant_id')
      .eq('user_id', authUser.id)
      .maybeSingle()

    if (existingMembership?.restaurant_id) {
      return NextResponse.json(
        { error: 'Restaurant already exists for this account' },
        { status: 400 }
      )
    }

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({
        full_name: fullName,
        phone: phone || null,
        email: authUser.email,
      })
      .eq('id', authUser.id)

    if (userUpdateError) {
      throw userUpdateError
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .insert({
        name: restaurantName,
        phone: phone || null,
        currency: 'NAD',
      })
      .select('id')
      .single()

    if (restaurantError || !restaurant?.id) {
      throw restaurantError || new Error('Failed to create restaurant')
    }

    const restaurantId = String(restaurant.id)

    const { error: restaurantUserError } = await supabase.from('restaurant_users').insert({
      restaurant_id: restaurantId,
      user_id: authUser.id,
      role: 'owner',
    })

    if (restaurantUserError) {
      throw restaurantUserError
    }

    const { error: setupError } = await supabase.from('restaurant_setup_status').insert({
      restaurant_id: restaurantId,
      profile_complete: false,
      tables_configured: false,
      menu_added: false,
      qr_downloaded: false,
      staff_added: false,
      terminal_connected: false,
      test_order_completed: false,
      first_payment_completed: false,
    })

    if (setupError) {
      throw setupError
    }

    return NextResponse.json({ success: true, restaurantId })
  } catch (error: unknown) {
    const message = errorMessage(error)
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    console.error('[create-restaurant] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
