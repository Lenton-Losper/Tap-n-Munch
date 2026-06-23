import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const token = String(searchParams.get('token') || '').trim()

    if (!token) {
      return NextResponse.json({ valid: false, reason: 'not_found' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const { data: invite, error } = await supabase
      .from('staff_invites')
      .select('id, email, role, expires_at, accepted, restaurant_id')
      .eq('token', token)
      .maybeSingle()

    if (error) throw error

    if (!invite) {
      return NextResponse.json({ valid: false, reason: 'not_found' })
    }

    if (invite.accepted) {
      return NextResponse.json({ valid: false, reason: 'already_accepted' })
    }

    const expiresAt = new Date(String(invite.expires_at))
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ valid: false, reason: 'expired' })
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name')
      .eq('id', invite.restaurant_id)
      .maybeSingle()

    if (restaurantError) throw restaurantError

    return NextResponse.json({
      valid: true,
      email: invite.email,
      restaurantName: String(restaurant?.name || 'Restaurant'),
      role: invite.role,
    })
  } catch (error: unknown) {
    console.error('[auth/invite] validation failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to validate invite'
    return NextResponse.json({ valid: false, reason: 'not_found', error: message }, { status: 500 })
  }
}
