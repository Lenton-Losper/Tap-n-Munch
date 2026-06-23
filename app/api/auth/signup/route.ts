import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Signup failed'
}

export async function POST(request: Request) {
  let authUserId: string | null = null
  const supabase = createServerSupabaseClient()

  try {
    const body = await request.json()
    const fullName = String(body?.fullName || '').trim()
    const email = String(body?.email || '').trim().toLowerCase()
    const password = String(body?.password || '')
    const restaurantName = String(body?.restaurantName || '').trim()
    const phone = String(body?.phone || '').trim()

    if (!fullName || !email || !password || !restaurantName) {
      return NextResponse.json(
        { error: 'Missing required fields: fullName, email, password, restaurantName' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (authError || !authData.user?.id) {
      return NextResponse.json(
        { error: authError?.message || 'Failed to create auth user' },
        { status: 500 }
      )
    }

    authUserId = authData.user.id

    const { error: userError } = await supabase.from('users').insert({
      id: authUserId,
      email,
      full_name: fullName,
      phone: phone || null,
    })

    if (userError) {
      throw userError
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .insert({
        name: restaurantName,
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
      user_id: authUserId,
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
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId).catch(() => {})
    }

    const message = errorMessage(error)
    console.error('[signup] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
