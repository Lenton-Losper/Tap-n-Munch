import { CacheKeys, redis, TTL } from '@/lib/redis'
import { createServerSupabaseClient } from '@/lib/supabase/server'

const CREDENTIALS_SELECT =
  'finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no'

type RestaurantCredentials = {
  merchantNo: string
  storeNo: string
  terminalSn: string | null
  checkoutMerchantNo: string
  checkoutStoreNo: string
}

function mapRestaurantCredentials(row: Record<string, unknown>): RestaurantCredentials {
  const merchantNo = String(row.merchantNo ?? row.finatic_merchant_no ?? '').trim()
  const storeNo = String(row.storeNo ?? row.finatic_store_no ?? '').trim()
  const terminalSnRaw = row.terminalSn ?? row.finatic_terminal_sn
  const terminalSn = terminalSnRaw ? String(terminalSnRaw).trim() : null
  const checkoutMerchantNo = String(row.checkoutMerchantNo ?? row.checkout_merchant_no ?? '').trim()
  const checkoutStoreNo = String(row.checkoutStoreNo ?? row.checkout_store_no ?? '').trim()
  return { merchantNo, storeNo, terminalSn, checkoutMerchantNo, checkoutStoreNo }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function fetchRestaurantCredentials(restaurantId: string) {
  const supabase = createServerSupabaseClient()
  const base = () =>
    supabase
      .from('restaurants')
      .select(CREDENTIALS_SELECT)
      .order('created_at', { ascending: true })
      .limit(1)

  if (isUuid(restaurantId)) {
    const { data, error } = await base().eq('id', restaurantId).maybeSingle()
    if (error) throw error
    if (data) return data
  }

  const { data: byFirebaseRestaurantId, error: firebaseRestaurantIdError } = await base()
    .eq('firebase_restaurant_id', restaurantId)
    .maybeSingle()

  if (firebaseRestaurantIdError) {
    const message = String(firebaseRestaurantIdError.message || '')
    if (!message.includes('firebase_restaurant_id')) {
      throw firebaseRestaurantIdError
    }
  } else if (byFirebaseRestaurantId) {
    return byFirebaseRestaurantId
  }

  const { data: byFirebaseId, error: firebaseIdError } = await base()
    .eq('firebase_id', restaurantId)
    .maybeSingle()

  if (firebaseIdError) {
    const message = String(firebaseIdError.message || '')
    if (!message.includes('firebase_id')) {
      throw firebaseIdError
    }
  } else if (byFirebaseId) {
    return byFirebaseId
  }

  return null
}

export async function getCachedRestaurantCredentials(restaurantId: string) {
  try {
    const cacheKey = CacheKeys.restaurant(restaurantId)
    const cached = await redis.get(cacheKey)

    if (cached) {
      console.log('[RESTAURANT CACHE] Hit for:', restaurantId)
      const parsed =
        typeof cached === 'string'
          ? (JSON.parse(cached) as Record<string, unknown>)
          : (cached as Record<string, unknown>)
      return mapRestaurantCredentials(parsed)
    }

    console.log('[RESTAURANT CACHE] Miss for:', restaurantId)
    const restaurant = await fetchRestaurantCredentials(restaurantId)

    if (!restaurant) {
      throw new Error(`Restaurant ${restaurantId} not found`)
    }

    const credentials = mapRestaurantCredentials(restaurant as Record<string, unknown>)
    await redis.setex(cacheKey, TTL.RESTAURANT, JSON.stringify(credentials))
    return credentials
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
