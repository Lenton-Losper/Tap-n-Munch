import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertPlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

const VALID_ROLES = ['super_admin', 'support'] as const
type PlatformAdminRole = (typeof VALID_ROLES)[number]

function isValidRole(value: string): value is PlatformAdminRole {
  return (VALID_ROLES as readonly string[]).includes(value)
}

export async function GET(request: Request) {
  const denied = await assertPlatformAdmin(request)
  if (denied) return denied

  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('platform_admins')
      .select('id, email, role, created_at')
      .order('created_at', { ascending: true })

    if (error) throw error
    return NextResponse.json({ admins: data ?? [] })
  } catch (err) {
    console.error('[platform/admins] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Minimal v1 invite flow: adds a platform admin by email directly (no separate
 * invite-and-accept step) -- acceptable given how few platform admins are expected.
 * A full email-invite flow can be built later if that changes.
 */
export async function POST(request: Request) {
  const denied = await assertPlatformAdmin(request)
  if (denied) return denied

  let actor
  try {
    actor = await getUserFromRequest(request)
  } catch {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = String(body.role ?? 'support').trim()

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
    }
    if (!isValidRole(role)) {
      return NextResponse.json({ error: "role must be 'super_admin' or 'support'" }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()

    const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    })
    if (listError) throw listError
    const targetAuthUser = existingUsers.users.find(
      (u) => (u.email || '').toLowerCase() === email,
    )
    if (!targetAuthUser) {
      return NextResponse.json(
        { error: 'No account exists for this email. They must sign up first.' },
        { status: 404 },
      )
    }

    const { data: inserted, error: insertError } = await supabase
      .from('platform_admins')
      .insert({ user_id: targetAuthUser.id, email, role })
      .select('id, email, role, created_at')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json({ error: 'This email is already a platform admin' }, { status: 409 })
      }
      throw insertError
    }

    await supabase.from('platform_audit_logs').insert({
      actor_id: actor.id,
      actor_email: actor.email ?? '',
      action: 'platform_admin_added',
      target_type: 'platform_admin',
      target_id: inserted.id,
      payload: { email, role },
      ip_address: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      success: true,
    })

    return NextResponse.json({ admin: inserted })
  } catch (err) {
    console.error('[platform/admins] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
