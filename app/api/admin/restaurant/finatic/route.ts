import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { invalidateRestaurantCache } from '@/lib/cache/restaurant-cache'

export const dynamic = 'force-dynamic'

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const merchantNo = String(body?.merchantNo || '').trim()
    const storeNo = String(body?.storeNo || '').trim()

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE)
    if (denied) return denied

    const { error } = await supabase
      .from('restaurants')
      .update({
        finatic_merchant_no: merchantNo || null,
        finatic_store_no: storeNo || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', restaurantId)

    if (error) throw error

    /**
     * THE SAVE IS NOT DONE UNTIL THE CACHE FORGETS THE OLD ANSWER.
     *
     * getCachedRestaurantCredentials (lib/cache/restaurant-cache.ts) reads Redis BEFORE Supabase,
     * so without this the row changes and the payment path keeps reading the pre-save value for
     * up to a full TTL.RESTAURANT. That is not theoretical: on 2026-09-01 Chownow Nedbank
     * (38c493cf-a665-42c5-9c3e-858fbdb52b40) had its credentials saved correctly and its
     * terminals kept refusing cards, because Redis still held
     * {"merchantNo":"","storeNo":"", ...} cached from when the columns were NULL, with 1957
     * seconds left to live. Two terminals showed staff "card payments are not set up at this
     * venue" for a venue that was, by then, set up.
     *
     * The gate those terminals hit is finatic-restaurant-credentials.ts's
     * `if (!merchantNo || !storeNo)`, and it reads through this cache — so the cache, not the
     * column, is what decides whether a venue can take a card in the minutes after onboarding.
     *
     * AFTER the write and only on success: invalidating before it would race a concurrent read
     * that would immediately re-cache the OLD row, and invalidating on a failed update would
     * throw away a good entry for no reason.
     *
     * NOT awaited for correctness of the response -- invalidateRestaurantCache swallows its own
     * errors and never throws, so a Redis outage cannot turn a committed save into a 500. It is
     * awaited so the invalidation is ordered before the caller is told the save succeeded.
     */
    await invalidateRestaurantCache(restaurantId)

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save account details'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
