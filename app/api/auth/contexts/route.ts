import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveUserContexts } from '@/lib/auth/resolve-user-contexts'

export const dynamic = 'force-dynamic'

/**
 * Contexts for the picker page (app/choose-context), with restaurant names
 * attached for display -- resolveUserContexts() itself stays name-agnostic
 * since the login/redirect precedence logic never needs a name, only the id.
 */
export async function GET(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const contexts = await resolveUserContexts(authUser.id)

    const restaurantIds = contexts
      .filter((c): c is Extract<typeof c, { type: 'restaurant' }> => c.type === 'restaurant')
      .map((c) => c.restaurantId)

    const namesById = new Map<string, string>()
    if (restaurantIds.length > 0) {
      const supabase = createServerSupabaseClient()
      const { data, error } = await supabase
        .from('restaurants')
        .select('id, name')
        .in('id', restaurantIds)
      if (error) throw error
      for (const row of data ?? []) {
        namesById.set(String(row.id), String(row.name ?? 'Restaurant'))
      }
    }

    const withNames = contexts.map((c) =>
      c.type === 'restaurant'
        ? { ...c, restaurantName: namesById.get(c.restaurantId) ?? 'Restaurant' }
        : c,
    )

    return NextResponse.json({ contexts: withNames })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
