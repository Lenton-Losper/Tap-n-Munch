import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertPlatformAdmin,
  requirePlatformRole,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'

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
  const actor = await requirePlatformRole(request, ['super_admin'])
  if (actor instanceof NextResponse) return actor

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

    await writePlatformAudit({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'platform_admin_added',
      targetType: 'platform_admin',
      targetId: inserted.id,
      payload: { email, role },
      request,
    })

    return NextResponse.json({ admin: inserted })
  } catch (err) {
    console.error('[platform/admins] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
