import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return fallback
}

export async function PATCH(request: Request) {
  let body: Record<string, unknown> = {}

  try {
    const user = await getUserFromRequest(request)
    body = await request.json()
    const name = String(body?.name || '').trim()
    const phone = String(body?.phone || '').trim()
    const address = String(body?.address || '').trim()
    const currency = String(body?.currency || 'NAD').trim()
    const logoUrl = body?.logoUrl ? String(body.logoUrl) : undefined

    console.log('[profile] user:', user.id)
    console.log('[profile] body:', body)

    if (!name) {
      return NextResponse.json({ error: 'Restaurant name is required' }, { status: 400 })
    }

    const allowedCurrencies = new Set(['NAD', 'ZAR', 'USD'])
    if (!allowedCurrencies.has(currency)) {
      return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    console.log('[profile] restaurantId:', restaurantId)

    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const updates: Record<string, unknown> = {
      name,
      phone: phone || null,
      address: address || null,
      currency,
      updated_at: new Date().toISOString(),
    }
    if (logoUrl) {
      updates.logo_url = logoUrl
    }

    const { error: restaurantError } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('id', restaurantId)

    console.log('[profile] update error:', restaurantError)

    if (restaurantError) throw restaurantError

    const { error: userPhoneError } = await supabase
      .from('users')
      .update({ phone: phone || null })
      .eq('id', user.id)

    if (userPhoneError) throw userPhoneError

    await markSetupStepComplete(supabase, restaurantId, 'profile_complete')

    return NextResponse.json({ success: true, restaurantId })
  } catch (error: unknown) {
    console.error('[profile] failed:', error)
    const message = getErrorMessage(error, 'Failed to save profile')
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
