import { NextResponse } from 'next/server'
import { createRestaurantForUserAtomic, upsertPublicUserProfile } from '@/lib/auth/create-restaurant'
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

function responseStatusForError(message: string): number {
  if (message.includes('authorization') || message.includes('session')) return 401
  if (message.includes('Restaurant already exists')) return 400
  if (message.includes('Missing required field')) return 400
  return 500
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

    const { data: existingMembership, error: membershipLookupError } = await supabase
      .from('restaurant_users')
      .select('restaurant_id')
      .eq('user_id', authUser.id)
      .maybeSingle()

    if (membershipLookupError) {
      console.error('[create-restaurant] membership lookup failed', {
        userId: authUser.id,
        error: membershipLookupError,
      })
      throw membershipLookupError
    }

    if (existingMembership?.restaurant_id) {
      return NextResponse.json(
        { error: 'Restaurant already exists for this account' },
        { status: 400 }
      )
    }

    await upsertPublicUserProfile(supabase, {
      id: authUser.id,
      email: authUser.email,
      fullName,
      phone,
    })

    const restaurantId = await createRestaurantForUserAtomic(supabase, {
      userId: authUser.id,
      email: authUser.email,
      fullName,
      phone,
      restaurantName,
    })

    return NextResponse.json({ success: true, restaurantId })
  } catch (error: unknown) {
    const message = errorMessage(error)
    console.error('[create-restaurant] failed:', { message, error })
    return NextResponse.json({ error: message }, { status: responseStatusForError(message) })
  }
}
