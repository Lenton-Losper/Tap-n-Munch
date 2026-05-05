import { CacheKeys, redis, TTL } from '@/lib/redis'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function getCachedRestaurantCredentials(restaurantId: string) {
  try {
    const cacheKey = CacheKeys.restaurant(restaurantId)
    const cached = await redis.get(cacheKey)

    if (cached) {
      console.log('[RESTAURANT CACHE] Hit for:', restaurantId)
      return typeof cached === 'string' ? JSON.parse(cached) : cached
    }

    console.log('[RESTAURANT CACHE] Miss for:', restaurantId)
    const supabase = createServerSupabaseClient()
    const { data: restaurant, error } = await supabase
      .from('restaurants')
      .select(
        'finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no, terminals'
      )
      .eq('firebase_id', restaurantId)
      .single()

    if (error || !restaurant) {
      throw new Error(error?.message || `Restaurant ${restaurantId} not found`)
    }

    await redis.setex(cacheKey, TTL.RESTAURANT, JSON.stringify(restaurant))
    return restaurant
  } catch (err) {
    console.error('[RESTAURANT CACHE] Error:', err)
    throw err
  }
}

export async function invalidateRestaurantCache(restaurantId: string) {
  try {
    await redis.del(CacheKeys.restaurant(restaurantId))
    console.log('[RESTAURANT CACHE] Invalidated for:', restaurantId)
  } catch (err) {
    console.error('[RESTAURANT CACHE] Failed to invalidate:', err)
  }
}
