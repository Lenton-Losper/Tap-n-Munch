import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { initializeUserData } from '@/lib/supabase/initialize-user-data'

export const dynamic = 'force-dynamic'

/**
 * Ensures a signed-in Supabase Auth user has a matching public.users row.
 * Repairs accounts where auth was recreated but email/restaurant link still exists.
 */
export async function POST(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const body = await request.json().catch(() => ({}))
    const restaurantName =
      typeof body?.restaurantName === 'string' ? body.restaurantName.trim() : ''

    const { data: userById, error: userByIdError } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle()

    if (userByIdError) {
      return NextResponse.json({ error: userByIdError.message }, { status: 400 })
    }

    if (userById?.id) {
      return NextResponse.json({ ok: true, user: userById, created: false })
    }

    const email = String(authUser.email || '').trim().toLowerCase()
    if (email) {
      const { data: userByEmail, error: userByEmailError } = await supabase
        .from('users')
        .select('*')
        .ilike('email', email)
        .maybeSingle()

      if (userByEmailError) {
        return NextResponse.json({ error: userByEmailError.message }, { status: 400 })
      }

      if (userByEmail?.restaurant_id) {
        const now = new Date().toISOString()
        const payload = {
          id: authUser.id,
          email: userByEmail.email || authUser.email,
          name: userByEmail.name || `${authUser.email?.split('@')[0] || 'Owner'} Owner`,
          phone: userByEmail.phone || '',
          role: userByEmail.role || 'owner',
          restaurant_id: userByEmail.restaurant_id,
          created_at: userByEmail.created_at || now,
          last_login: now,
        }

        if (userByEmail.id !== authUser.id) {
          // The old row may still be referenced by restaurants.owner_id
          // (restaurants_owner_id_fkey has no ON DELETE action), so detach it
          // first or the delete below fails outright when the account being
          // repaired is the current owner.
          if (userByEmail.role === 'owner') {
            await supabase
              .from('restaurants')
              .update({ owner_id: null })
              .eq('id', userByEmail.restaurant_id)
              .eq('owner_id', userByEmail.id)
          }

          await supabase.from('users').delete().eq('id', userByEmail.id)
        }

        const { data: relinked, error: relinkError } = await supabase
          .from('users')
          .insert(payload)
          .select('*')
          .single()

        if (relinkError) {
          return NextResponse.json({ error: relinkError.message }, { status: 400 })
        }

        // Only follow the relinked account into restaurants.owner_id when it's
        // actually the owner — otherwise a manager/staff repair would silently
        // reassign ownership away from the real owner (#8).
        if (payload.role === 'owner') {
          await supabase
            .from('restaurants')
            .update({ owner_id: authUser.id, updated_at: now })
            .eq('id', userByEmail.restaurant_id)
        }

        return NextResponse.json({ ok: true, user: relinked, created: true, relinked: true })
      }
    }

    const { data: ownedRestaurant, error: ownedRestaurantError } = await supabase
      .from('restaurants')
      .select('id, name')
      .eq('owner_id', authUser.id)
      .maybeSingle()

    if (ownedRestaurantError) {
      return NextResponse.json({ error: ownedRestaurantError.message }, { status: 400 })
    }

    if (ownedRestaurant?.id) {
      const now = new Date().toISOString()
      const { data: createdUser, error: createUserError } = await supabase
        .from('users')
        .insert({
          id: authUser.id,
          email: authUser.email,
          name: `${ownedRestaurant.name || 'Restaurant'} Owner`,
          phone: '',
          role: 'owner',
          restaurant_id: ownedRestaurant.id,
          created_at: now,
          last_login: now,
        })
        .select('*')
        .single()

      if (createUserError) {
        return NextResponse.json({ error: createUserError.message }, { status: 400 })
      }

      return NextResponse.json({ ok: true, user: createdUser, created: true })
    }

    if (!restaurantName) {
      return NextResponse.json(
        { error: 'No profile found for this account. Sign up with a restaurant name or contact support.' },
        { status: 404 }
      )
    }

    const initialized = await initializeUserData(authUser.id, authUser.email || email, restaurantName)
    const { data: newUser, error: loadError } = await supabase
      .from('users')
      .select('*')
      .eq('id', initialized.userId)
      .single()

    if (loadError) {
      return NextResponse.json({ error: loadError.message }, { status: 400 })
    }

    return NextResponse.json({ ok: true, user: newUser, created: true, initialized: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Profile sync failed'
    return NextResponse.json({ error: message }, { status: 401 })
  }
}
