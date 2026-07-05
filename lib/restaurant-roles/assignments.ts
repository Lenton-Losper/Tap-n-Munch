import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export async function countRoleAssignments(
  supabase: Supabase,
  restaurantId: string,
  roleSlug: string,
): Promise<number> {
  const [users, invites, members] = await Promise.all([
    supabase
      .from('restaurant_users')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('role', roleSlug)
      .is('deleted_at', null),
    supabase
      .from('staff_invites')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('role', roleSlug),
    supabase
      .from('staff_members')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('role', roleSlug),
  ])

  if (users.error) throw users.error
  if (invites.error) throw invites.error
  if (members.error) throw members.error

  return (users.count ?? 0) + (invites.count ?? 0) + (members.count ?? 0)
}

export async function getAssignmentCountsByRole(
  supabase: Supabase,
  restaurantId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  const addRows = (rows: Array<{ role: string }> | null) => {
    for (const row of rows ?? []) {
      const slug = String(row.role)
      counts[slug] = (counts[slug] ?? 0) + 1
    }
  }

  const [users, invites, members] = await Promise.all([
    supabase
      .from('restaurant_users')
      .select('role')
      .eq('restaurant_id', restaurantId)
      .is('deleted_at', null),
    supabase.from('staff_invites').select('role').eq('restaurant_id', restaurantId),
    supabase.from('staff_members').select('role').eq('restaurant_id', restaurantId),
  ])

  if (users.error) throw users.error
  if (invites.error) throw invites.error
  if (members.error) throw members.error

  addRows(users.data)
  addRows(invites.data)
  addRows(members.data)

  return counts
}
