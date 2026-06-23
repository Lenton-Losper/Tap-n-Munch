import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Failed to accept invite'
}

export async function POST(request: Request) {
  let authUserId: string | null = null
  const supabase = createServerSupabaseClient()

  try {
    const body = await request.json()
    const token = String(body?.token || '').trim()
    const fullName = String(body?.fullName || '').trim()
    const password = String(body?.password || '')

    if (!token || !fullName || !password) {
      return NextResponse.json(
        { error: 'Missing required fields: token, fullName, password' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const { data: invite, error: inviteError } = await supabase
      .from('staff_invites')
      .select('id, email, role, expires_at, accepted, restaurant_id')
      .eq('token', token)
      .maybeSingle()

    if (inviteError) throw inviteError
    if (!invite) {
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    }

    if (invite.accepted) {
      return NextResponse.json({ error: 'This invite has already been accepted' }, { status: 400 })
    }

    const expiresAt = new Date(String(invite.expires_at))
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'This invite has expired' }, { status: 400 })
    }

    const email = String(invite.email).trim().toLowerCase()
    const restaurantId = String(invite.restaurant_id)
    const role = String(invite.role).toLowerCase()

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })

    if (authError || !authData.user?.id) {
      return NextResponse.json(
        { error: authError?.message || 'Failed to create account' },
        { status: 500 }
      )
    }

    authUserId = authData.user.id

    const { error: userError } = await supabase.from('users').insert({
      id: authUserId,
      email,
      full_name: fullName,
    })

    if (userError) throw userError

    const { error: membershipError } = await supabase.from('restaurant_users').insert({
      restaurant_id: restaurantId,
      user_id: authUserId,
      role,
    })

    if (membershipError) throw membershipError

    const now = new Date().toISOString()
    const { error: inviteUpdateError } = await supabase
      .from('staff_invites')
      .update({ accepted: true, accepted_at: now })
      .eq('id', invite.id)

    if (inviteUpdateError) throw inviteUpdateError

    return NextResponse.json({ success: true, email })
  } catch (error: unknown) {
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId).catch(() => {})
    }

    const message = getErrorMessage(error)
    console.error('[auth/invite/accept] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
