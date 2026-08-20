import { NextResponse } from 'next/server'
import { createRestaurantForUserAtomic, upsertPublicUserProfile } from '@/lib/auth/create-restaurant'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdsForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

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
    const businessName = String(body?.businessName || '').trim()

    if (!restaurantName || !fullName) {
      return NextResponse.json(
        { error: 'Missing required fields: restaurantName, fullName' },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()

    // An EXISTENCE check, not a pick: "does this account already have any restaurant?". It used
    // to be a bare .maybeSingle(), which raises PGRST116 the moment an account holds two
    // memberships -- a 500 where the honest answer is the 400 below.
    let existingRestaurantIds: string[]
    try {
      existingRestaurantIds = await getRestaurantIdsForUser(supabase, authUser.id)
    } catch (membershipLookupError) {
      console.error('[create-restaurant] membership lookup failed', {
        userId: authUser.id,
        error: membershipLookupError,
      })
      throw membershipLookupError
    }

    if (existingRestaurantIds.length > 0) {
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
      organizationName: businessName,
    })

    return NextResponse.json({ success: true, restaurantId })
  } catch (error: unknown) {
    const message = errorMessage(error)
    console.error('[create-restaurant] failed:', { message, error })
    return NextResponse.json({ error: message }, { status: responseStatusForError(message) })
  }
}
