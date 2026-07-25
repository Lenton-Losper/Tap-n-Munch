import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { destinationForContext, resolveUserContexts, type UserContext } from '@/lib/auth/resolve-user-contexts'

export const dynamic = 'force-dynamic'

/**
 * Records the picker's choice into user_active_context, so this only needs
 * to happen once until the user has a reason to switch (Phase 2 proper
 * switcher). The requested context is re-validated against the user's real
 * resolveUserContexts() here -- never trust a client-supplied type/id pair
 * blindly, the same way the redirect-param path never trusted an unverified
 * redirect.
 */
export async function POST(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const body = await request.json().catch(() => ({}))

    const requestedType = body?.type === 'platform' ? 'platform' : body?.type === 'restaurant' ? 'restaurant' : null
    if (!requestedType) {
      return NextResponse.json({ error: "type must be 'platform' or 'restaurant'" }, { status: 400 })
    }
    const requestedRestaurantId =
      requestedType === 'restaurant' && typeof body?.restaurantId === 'string' ? body.restaurantId : null
    if (requestedType === 'restaurant' && !requestedRestaurantId) {
      return NextResponse.json({ error: 'restaurantId is required for type restaurant' }, { status: 400 })
    }

    const contexts = await resolveUserContexts(authUser.id)
    const matched: UserContext | undefined = contexts.find((c) => {
      if (c.type !== requestedType) return false
      if (c.type === 'restaurant') return c.restaurantId === requestedRestaurantId
      return true
    })

    if (!matched) {
      return NextResponse.json({ error: 'You do not have access to that context.' }, { status: 403 })
    }

    const supabase = createServerSupabaseClient()
    const { error } = await supabase.from('user_active_context').upsert(
      {
        user_id: authUser.id,
        context_type: matched.type,
        restaurant_id: matched.type === 'restaurant' ? matched.restaurantId : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    if (error) throw error

    return NextResponse.json({ destination: destinationForContext(matched) })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
