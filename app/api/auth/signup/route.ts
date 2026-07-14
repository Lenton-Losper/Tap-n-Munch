import { NextResponse } from 'next/server'
import { createRestaurantForUserAtomic } from '@/lib/auth/create-restaurant'
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

    const restaurantId = await createRestaurantForUserAtomic(supabase, {
      userId: authUserId,
      email,
      fullName,
      phone,
      restaurantName,
    })

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
