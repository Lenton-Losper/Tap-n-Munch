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
    const scope = String(url.searchParams.get('scope') || '').trim()

    /**
     * `?scope=venue_staff` — WHO WORKS HERE. NOT who may authorise anything.
     *
     * ============================================================================================
     * THIS LIST IS FOR ATTRIBUTION, NOT AUTHORISATION. THE DIFFERENCE MATTERS.
     * ============================================================================================
     *
     * The `?purpose=` mode below answers "who may approve this privileged action", and it earns
     * that by filtering twice: to users holding a terminal PIN credential, and then to users
     * holding the permission the purpose maps to. Selecting from it is a step toward proving
     * something, which the PIN then completes.
     *
     * This mode answers a different question, for the gratuity picker: WHICH MEMBER OF STAFF IS
     * TAKING THIS TIP. Nobody is approving anything, so both filters are wrong here:
     *
     *   - the PIN-credential filter would hide a waiter who has no PIN, and a waiter without a PIN
     *     can still be handed a tip;
     *   - the permission filter has nothing to test, because receiving a gratuity is not a
     *     permission, and inventing one would drag a tip back toward being an authorisation.
     *
     * SO THE RESULT OF THIS MODE IS AN UNVERIFIED CLAIM. Anyone holding the terminal can pick
     * anyone on it. That is acceptable for a gratuity -- a mis-tap misattributes a tip, which is a
     * payroll correction -- and it is NOT acceptable for a refund, a cash settlement, or a walkout
     * close, each of which writes away money or debt and must go through `?purpose=` and a PIN.
     *
     * DO NOT REUSE THIS MODE TO SKIP A PIN ON A PRIVILEGED ACTION. If you are reading this because
     * a PIN is inconvenient, the answer is no.
     */
    if (scope === 'venue_staff') {
      const { data: staff, error: staffError } = await supabase
        .from('restaurant_users')
        .select('user_id, users!restaurant_users_user_id_fkey(full_name, name)')
        .eq('restaurant_id', terminal.restaurantId)
        .is('deleted_at', null)

      if (staffError) throw staffError

      const venueStaff = ((staff ?? []) as MembershipRow[])
        .map((row) => ({
          user_id: String(row.user_id),
          name: displayNameFromUser(resolveJoinedUser(row.users)),
        }))
        // A member with no name cannot be picked meaningfully, and a blank row invites a mis-tap
        // onto whoever happens to sit next to it.
        .filter((u) => u.name.trim().length > 0)

      venueStaff.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      // `verified: false` is on the wire deliberately: the caller is told what it is holding.
      return NextResponse.json({ users: venueStaff, verified: false })
    }

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
