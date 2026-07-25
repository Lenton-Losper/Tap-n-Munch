import { createServerSupabaseClient } from '@/lib/supabase/server'

export type UserContext =
  | { type: 'platform'; role: 'super_admin' | 'support' }
  | { type: 'restaurant'; restaurantId: string; role: string }

/**
 * Every context a user has, as an explicit array -- replaces the scattered
 * isPlatformAdmin-boolean-plus-restaurantId-list checks that used to be
 * spread across the login/redirect paths and app/admin/layout.tsx. Pulls
 * directly from platform_admins and restaurant_users (deliberately not the
 * restaurants.owner_id fallback app/api/auth/role/route.ts uses for general
 * session bootstrap -- that's a different, broader concern from "which
 * contexts can this account choose between at login").
 */
export async function resolveUserContexts(userId: string): Promise<UserContext[]> {
  const supabase = createServerSupabaseClient()

  const [{ data: adminRow, error: adminError }, { data: restaurantRows, error: restaurantError }] =
    await Promise.all([
      supabase.from('platform_admins').select('role').eq('user_id', userId).maybeSingle(),
      supabase
        .from('restaurant_users')
        .select('restaurant_id, role')
        .eq('user_id', userId)
        .is('deleted_at', null),
    ])

  if (adminError) throw adminError
  if (restaurantError) throw restaurantError

  const contexts: UserContext[] = []

  if (adminRow) {
    const role = adminRow.role === 'super_admin' ? 'super_admin' : 'support'
    contexts.push({ type: 'platform', role })
  }

  for (const row of restaurantRows ?? []) {
    if (!row.restaurant_id) continue
    contexts.push({ type: 'restaurant', restaurantId: String(row.restaurant_id), role: String(row.role ?? '') })
  }

  return contexts
}

export function contextsEqual(a: UserContext, b: UserContext): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'restaurant' && b.type === 'restaurant') return a.restaurantId === b.restaurantId
  return true
}

export function destinationForContext(context: UserContext): string {
  return context.type === 'platform' ? '/admin' : '/dashboard'
}
