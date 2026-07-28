import { CacheKeys, getRedis, TTL } from '@/lib/redis'
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
  const cacheKey = CacheKeys.restaurant(restaurantId)

  // Redis is a best-effort cache in front of Supabase, not the source of truth --
  // a Redis outage/misconfiguration must degrade to a cache miss (query Supabase
  // directly), not take down every caller of this function. Mirrors the fallback
  // pattern in lib/cache/menu-cache.ts. Read and write are guarded separately so a
  // failed cache write never discards credentials Supabase already returned
  // successfully (the same class of bug fixed in payments/paycloud.js's response
  // signature check).
  try {
    const cached = await getRedis().get(cacheKey)
    if (cached) {
      console.log('[RESTAURANT CACHE] Hit for:', restaurantId)
      const parsed =
        typeof cached === 'string'
          ? (JSON.parse(cached) as Record<string, unknown>)
          : (cached as Record<string, unknown>)
      return mapRestaurantCredentials(parsed)
    }
    console.log('[RESTAURANT CACHE] Miss for:', restaurantId)
  } catch (err) {
    console.error('[RESTAURANT CACHE] Redis read error, falling back to DB:', err)
  }

  const restaurant = await fetchRestaurantCredentials(restaurantId)
  if (!restaurant) {
    throw new Error(`Restaurant ${restaurantId} not found`)
  }
  const credentials = mapRestaurantCredentials(restaurant as Record<string, unknown>)

  try {
    await getRedis().setex(cacheKey, TTL.RESTAURANT, JSON.stringify(credentials))
  } catch (err) {
    console.error('[RESTAURANT CACHE] Failed to cache credentials:', err)
  }

  return credentials
}

export async function invalidateRestaurantCache(restaurantId: string) {
  try {
    await getRedis().del(CacheKeys.restaurant(restaurantId))
    console.log('[RESTAURANT CACHE] Invalidated for:', restaurantId)
  } catch (err) {
    console.error('[RESTAURANT CACHE] Failed to invalidate:', err)
  }
}
