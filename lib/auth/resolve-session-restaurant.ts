import type { SupabaseClient } from '@supabase/supabase-js'
import { pickSessionRestaurant } from '@/lib/auth/pick-session-restaurant'

/**
 * THE ONE PLACE THAT ANSWERS "WHICH RESTAURANT IS THIS USER ON?".
 *
 * Before this existed there were TEN copies of the answer: nine byte-identical
 * `resolveStaffRestaurantId` functions (lib/{analytics,documents,menu,orders,recipes,settings,
 * staff,stock,tables}/auth.ts) plus a tenth in app/api/admin/setup-status. Each took the first
 * restaurant_users row with no ORDER BY. While every account had exactly one restaurant they all
 * agreed and the duplication was invisible.
 *
 * The day an account held two, they stopped agreeing -- and they would have disagreed PER PAGE.
 * Analytics and Stock are money screens. A user reading revenue for one restaurant while the
 * dashboard header named another is not a cosmetic bug, and nothing in the type system or the
 * tests would have caught it, because each copy was individually correct.
 *
 * scripts/check-session-restaurant-resolver.ts fails the build if a call site starts answering the
 * question itself again. Ten copies converged by hand stay converged only if something enforces it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE STORED SELECTION IS A PREFERENCE, NEVER A GRANT, AND NEVER A TRAP
 * ---------------------------------------------------------------------------------------------
 *
 * It lives in `public.user_active_context` -- a table, one row per user (user_id PRIMARY KEY), not
 * a cookie and not the JWT, so it cannot be forged client-side and does not need re-issuing. RLS
 * lets a user SELECT only their own row; there is no authenticated INSERT/UPDATE policy at all,
 * so writes happen solely through /api/auth/select-context, which re-derives the caller's real
 * contexts before storing anything.
 *
 * What happens when it names a restaurant the user can no longer use:
 *
 *   restaurant deleted    the FK is ON DELETE CASCADE, so the context row goes with it. No stored
 *                         value survives a deleted restaurant.
 *   membership revoked    the FK knows nothing about restaurant_users, so the row DOES survive.
 *                         `memberRestaurantIds` is re-derived from restaurant_users on every single
 *                         call and pickSessionRestaurant discards any stored id not in it.
 *   membership soft-      the membership query filters `deleted_at IS NULL`, so a soft-deleted row
 *   deleted               is not a membership and the stored id stops matching.
 *   user deleted          ON DELETE CASCADE from auth.users.
 *   read fails            treated as "no preference" and logged, never thrown. A broken preference
 *                         row must not be able to lock someone out of their own account.
 *
 * In every one of those cases it falls back to a restaurant the user DOES belong to
 * (`memberRestaurantIds[0]`), then to the legacy `restaurants.owner_id` column, then to null. The
 * stored value can only ever NARROW the choice among current memberships. It can never widen it,
 * so a stale row cannot fail open, and it can never be the only candidate, so it cannot strand
 * anyone on a site they cannot use.
 */
export async function resolveSessionRestaurantId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: memberships, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id, role')
    .eq('user_id', userId)
    .is('deleted_at', null)

  if (membershipError) throw membershipError

  // Owner rows first, matching getRestaurantIdsForUser -- a deterministic fallback order for the
  // no-preference case. It does NOT disambiguate two owner rows, which is exactly why the stored
  // selection has to exist.
  const memberRestaurantIds = (memberships ?? [])
    .slice()
    .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))
    .map((row) => String(row.restaurant_id))
    .filter(Boolean)

  let storedRestaurantId: string | null = null
  const { data: storedContext, error: storedError } = await supabase
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (storedError) {
    console.error(
      '[resolve-session-restaurant] user_active_context read failed, falling back:',
      storedError.message,
    )
  } else if (storedContext?.context_type === 'restaurant' && storedContext.restaurant_id) {
    storedRestaurantId = String(storedContext.restaurant_id)
  }

  const picked = pickSessionRestaurant({ memberRestaurantIds, storedRestaurantId })
  if (picked.restaurantId) {
    return picked.restaurantId
  }

  // Legacy fallback for accounts provisioned before restaurant_users existed.
  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id')
    .eq('owner_id', userId)
    .limit(1)
    .maybeSingle()

  if (restaurantError) throw restaurantError
  return restaurant?.id ? String(restaurant.id) : null
}
