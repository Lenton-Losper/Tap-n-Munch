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
 * Make this waiter the current owner of the table, whatever was there before.
 *
 * ============================================================================================
 * ADOPTION, NOT REFUSAL
 * ============================================================================================
 *
 * RULED: opening a table that already has an open tab ADOPTS it. The service session attaches to
 * the existing tab and the waiter becomes owner. It does not create a second tab and it does not
 * refuse. Same principle as QR joining an existing session: ONE service session per table,
 * however it was started.
 *
 * Refusing would have been the quiet disaster. Riviera has tables carrying open tabs right now,
 * and a waiter who cannot open them cannot serve those tables at all -- on the first morning,
 * with no workaround on the device.
 *
 * ============================================================================================
 * A HANDOVER IS RELEASE-THEN-ASSIGN, AND BOTH ROWS SURVIVE
 * ============================================================================================
 *
 * If someone else holds the table, their assignment is CLOSED (released_at set) and a new one is
 * opened. Nothing is overwritten and nothing is deleted, so "who had table 12 last Tuesday" still
 * answers correctly and the partial unique index -- one open assignment per table -- is never
 * violated.
 *
 * This deliberately does NOT touch tabs.opened_by_user_id. That is the tip anchor and it is
 * immutable once set; a handover must never move money that was already earned. The caller fills
 * it only when it is NULL.
 */
export async function claimTableForWaiter(
  supabase: SupabaseClient,
  restaurantId: string,
  tableId: string,
  waiterUserId: string,
): Promise<{ ok: boolean; handedOverFrom: string | null }> {
  try {
    const { data: existing, error: existingError } = await supabase
      .from('service_table_assignments')
      .select('id, waiter_user_id')
      .eq('restaurant_id', restaurantId)
      .eq('table_id', tableId)
      .is('released_at', null)
      .maybeSingle()

    if (existingError) throw existingError

    // Already theirs. Re-opening your own table is not a handover and must not litter the
    // history with a release/assign pair every time a waiter taps back into it.
    if (existing?.waiter_user_id && String(existing.waiter_user_id) === waiterUserId) {
      return { ok: true, handedOverFrom: null }
    }

    let handedOverFrom: string | null = null

    if (existing?.id) {
      handedOverFrom = String(existing.waiter_user_id)
      const { error: releaseError } = await supabase
        .from('service_table_assignments')
        .update({ released_at: new Date().toISOString() })
        .eq('id', existing.id)
        .is('released_at', null)

      if (releaseError) throw releaseError
    }

    const { error: assignError } = await supabase.from('service_table_assignments').insert({
      restaurant_id: restaurantId,
      table_id: tableId,
      waiter_user_id: waiterUserId,
      assigned_by_user_id: waiterUserId,
    })

    if (assignError) throw assignError

    return { ok: true, handedOverFrom }
  } catch (err) {
    // The tab is what lets the waiter serve the table; the assignment only puts a name on the
    // grid. Refusing the open over a failed assignment would cost the customer their order.
    console.error(
      '[table-owners] could not claim the table for this waiter — the floor grid will show it ' +
        'with no owner, and tip attribution is unaffected because it reads tabs.opened_by_user_id',
      { restaurantId, tableId, waiterUserId, error: err },
    )
    return { ok: false, handedOverFrom: null }
  }
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
      .from('service_table_assignments')
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
