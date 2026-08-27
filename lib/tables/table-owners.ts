/**
 * ADR-005 §3 -- who currently owns each table, resolved to a name the floor grid can print.
 *
 * Shared by the floor grid and the open-table route so the two cannot drift into disagreeing
 * about who has table 12. One query for the whole floor rather than one per table: the grid is
 * the screen a waiter stares at all night, and it refreshes constantly.
 *
 * A MISSING OWNER IS NEVER AN ERROR. It happens legitimately -- a QR tab nobody was assigned to,
 * or a table whose assignment insert failed while its tab succeeded. The grid prints no name and
 * the waiter carries on; tip attribution is unaffected either way because it reads
 * tabs.opened_by_user_id, not this.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type TableOwner = {
  user_id: string
  /** Display name. Empty string when the user row has neither full_name nor name. */
  name: string
  /** When this waiter took the table -- the grid's "owner since". */
  assigned_at: string
}

type UserNameRow = { id: string; full_name: string | null; name: string | null }

function displayName(user: UserNameRow | undefined): string {
  if (!user) return ''
  return String(user.full_name || user.name || '').trim()
}

/**
 * Current owners for the given tables, keyed by table_id.
 *
 * Only open assignments are considered -- `released_at IS NULL` -- which is the same definition
 * the partial unique index enforces, so at most one row can match per table.
 */
export async function loadTableOwners(
  supabase: SupabaseClient,
  restaurantId: string,
  tableIds: string[],
): Promise<Map<string, TableOwner>> {
  const owners = new Map<string, TableOwner>()
  const ids = [...new Set(tableIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
  if (ids.length === 0) return owners

  try {
    const { data: assignments, error: assignmentsError } = await supabase
      .from('table_assignments')
      .select('table_id, waiter_user_id, assigned_at')
      .eq('restaurant_id', restaurantId)
      .in('table_id', ids)
      .is('released_at', null)

    if (assignmentsError) throw assignmentsError

    const rows = (assignments ?? []) as Array<{
      table_id: string
      waiter_user_id: string
      assigned_at: string
    }>
    if (rows.length === 0) return owners

    const userIds = [...new Set(rows.map((r) => String(r.waiter_user_id)).filter(Boolean))]

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, full_name, name')
      .in('id', userIds)

    if (usersError) throw usersError

    const usersById = new Map<string, UserNameRow>()
    for (const user of (users ?? []) as UserNameRow[]) {
      usersById.set(String(user.id), user)
    }

    for (const row of rows) {
      owners.set(String(row.table_id), {
        user_id: String(row.waiter_user_id),
        name: displayName(usersById.get(String(row.waiter_user_id))),
        assigned_at: String(row.assigned_at),
      })
    }
  } catch (err) {
    // Cosmetic. The grid loses owner names for this refresh; it does not lose the tables.
    console.error('[table-owners] could not resolve table owners', err)
  }

  return owners
}
