// randomUUID is available globally via Web Crypto API (runtime-independent)
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { sendStaffInviteEmail } from '@/lib/email/templates/staff-invite'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

function normalizeRole(value: string): 'manager' | 'waiter' | null {
  const role = value.trim().toLowerCase()
  if (role === 'manager' || role === 'waiter') return role
  return null
}

function createInviteToken(): string {
  return crypto.randomUUID()
}

function getAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const { data, error } = await supabase
      .from('staff_invites')
      .select('id, email, role, accepted, expires_at, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })

    if (error) throw error

    const invites = (data || []).map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.accepted ? 'accepted' : 'pending',
      created_at: row.created_at,
      expires_at: row.expires_at,
    }))

    return NextResponse.json({ invites })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load invites'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const email = String(body?.email || '')
      .trim()
      .toLowerCase()
    const role = normalizeRole(String(body?.role || ''))

    if (!email || !role) {
      return NextResponse.json(
        { error: 'Valid email and role (manager or waiter) are required' },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name')
      .eq('id', restaurantId)
      .maybeSingle()

    if (restaurantError) throw restaurantError

    const token = createInviteToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('staff_invites')
      .insert({
        restaurant_id: restaurantId,
        email,
        role,
        token,
        expires_at: expiresAt,
        invited_by: user.id,
        accepted: false,
      })
      .select('id, email, role, accepted, expires_at, created_at')
      .single()

    if (error) throw error

    const inviteUrl = `${getAppUrl()}/invite?token=${encodeURIComponent(token)}`
    const restaurantName = String(restaurant?.name || 'your restaurant')

    try {
      await sendStaffInviteEmail({
        to: email,
        restaurantName,
        role,
        inviteUrl,
      })
    } catch (emailError) {
      console.error('[invites] email send failed (non-fatal):', emailError)
    }

    await markSetupStepComplete(supabase, restaurantId, 'staff_added')

    return NextResponse.json({
      success: true,
      invite: {
        ...data,
        status: data?.accepted ? 'accepted' : 'pending',
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to send invite'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[invites] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
