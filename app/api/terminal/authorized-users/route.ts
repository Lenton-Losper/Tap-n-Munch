import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { authorize } from '@/lib/permissions/authorize'
import { resolveTerminalAuthorizationPermission } from '@/lib/terminal-auth/purpose-permissions'

export const dynamic = 'force-dynamic'

type UserJoinRow = {
  full_name: string | null
  name: string | null
}

type MembershipRow = {
  user_id: string
  users: UserJoinRow | UserJoinRow[] | null
}

function displayNameFromUser(user: UserJoinRow | null): string {
  if (!user) return ''
  return String(user.full_name || user.name || '').trim()
}

function resolveJoinedUser(users: MembershipRow['users']): UserJoinRow | null {
  if (!users) return null
  if (Array.isArray(users)) return users[0] ?? null
  return users
}

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const url = new URL(req.url)
    const purpose = String(url.searchParams.get('purpose') || '').trim()
    const permission = resolveTerminalAuthorizationPermission(purpose)

    if (!permission) {
      return NextResponse.json({ error: 'Unrecognized purpose' }, { status: 400 })
    }

    const { data: credentials, error: credentialsError } = await supabase
      .from('terminal_authorization_credentials')
      .select('user_id')
      .eq('restaurant_id', terminal.restaurantId)

    if (credentialsError) throw credentialsError

    const credentialUserIds = (credentials ?? []).map((row) => String(row.user_id))
    if (credentialUserIds.length === 0) {
      return NextResponse.json({ users: [] })
    }

    const { data: members, error: membersError } = await supabase
      .from('restaurant_users')
      .select('user_id, users!restaurant_users_user_id_fkey(full_name, name)')
      .eq('restaurant_id', terminal.restaurantId)
      .in('user_id', credentialUserIds)
      .is('deleted_at', null)

    if (membersError) throw membersError

    const authorizedUsers: Array<{ user_id: string; name: string }> = []

    for (const row of (members ?? []) as MembershipRow[]) {
      const userId = String(row.user_id)
      const allowed = await authorize(userId, terminal.restaurantId, permission)
      if (!allowed) continue

      authorizedUsers.push({
        user_id: userId,
        name: displayNameFromUser(resolveJoinedUser(row.users)),
      })
    }

    authorizedUsers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    return NextResponse.json({ users: authorizedUsers })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/authorized-users GET] failed:', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
