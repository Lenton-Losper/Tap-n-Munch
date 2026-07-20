import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveStaffMemberId } from '@/lib/permissions/authorize'

/**
 * Coordinated public.users.email + staff_members.email update, with a
 * resolveStaffMemberId re-check afterward. Same pattern used (and verified
 * against production data) to repair the FNB ChowNow account: update both
 * tables together, then confirm the staff-permission lookup still resolves
 * to the same row it did before.
 *
 * public.users.id === auth.users.id by convention everywhere in this
 * codebase (see lib/auth/ensure-public-user.ts), so `userId` here is always
 * an auth user id.
 */
export type SyncUserEmailResult = {
  ok: boolean
  userId: string
  oldEmail: string | null
  newEmail: string
  staffMembersUpdated: Array<{ id: string; restaurantId: string }>
  verifications: Array<{ restaurantId: string; staffId: string; resolvedId: string | null; ok: boolean }>
  error?: string
}

export async function syncUserEmailAcrossTables(
  userId: string,
  newEmail: string,
): Promise<SyncUserEmailResult> {
  const supabase = createServerSupabaseClient()
  const normalizedNew = String(newEmail || '').trim()

  const empty = (error?: string): SyncUserEmailResult => ({
    ok: false,
    userId,
    oldEmail: null,
    newEmail: normalizedNew,
    staffMembersUpdated: [],
    verifications: [],
    error,
  })

  if (!normalizedNew) {
    return empty('newEmail is required')
  }

  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle()
  if (userErr) return empty(userErr.message)

  const oldEmail = userRow?.email ? String(userRow.email) : null

  // Find matching staff_members rows BEFORE touching public.users, so we know
  // exactly which rows to update (and can roll back to the same known state).
  const { data: staffRows, error: staffLookupErr } = oldEmail
    ? await supabase.from('staff_members').select('id, restaurant_id').ilike('email', oldEmail)
    : { data: [] as Array<{ id: string; restaurant_id: string }>, error: null }
  if (staffLookupErr) {
    return { ...empty(staffLookupErr.message), oldEmail }
  }

  const { error: publicUpdateErr } = await supabase
    .from('users')
    .update({ email: normalizedNew })
    .eq('id', userId)
  if (publicUpdateErr) {
    return { ...empty(publicUpdateErr.message), oldEmail }
  }

  const staffMembersUpdated: Array<{ id: string; restaurantId: string }> = []
  for (const row of staffRows ?? []) {
    const { error: staffUpdateErr } = await supabase
      .from('staff_members')
      .update({ email: normalizedNew })
      .eq('id', row.id)
    if (staffUpdateErr) {
      // Roll back public.users so the two tables never disagree silently.
      await supabase.from('users').update({ email: oldEmail }).eq('id', userId)
      return {
        ok: false,
        userId,
        oldEmail,
        newEmail: normalizedNew,
        staffMembersUpdated,
        verifications: [],
        error: staffUpdateErr.message,
      }
    }
    staffMembersUpdated.push({ id: String(row.id), restaurantId: String(row.restaurant_id) })
  }

  const verifications: SyncUserEmailResult['verifications'] = []
  for (const { id: staffId, restaurantId } of staffMembersUpdated) {
    const resolvedId = await resolveStaffMemberId(userId, restaurantId)
    verifications.push({ restaurantId, staffId, resolvedId, ok: resolvedId === staffId })
  }

  return {
    ok: verifications.every((v) => v.ok),
    userId,
    oldEmail,
    newEmail: normalizedNew,
    staffMembersUpdated,
    verifications,
  }
}
