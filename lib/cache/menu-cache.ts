import { CacheKeys, getRedis, TTL } from '@/lib/redis'

export async function getCachedMenu(restaurantId: string, categoryId?: string) {
  try {
    const cacheKey = categoryId
      ? CacheKeys.menuCategory(restaurantId, categoryId)
      : CacheKeys.menu(restaurantId)
    const cached = await getRedis().get(cacheKey)

    if (cached) {
      console.log('[MENU CACHE] Hit for restaurant:', restaurantId, categoryId ? `(category ${categoryId})` : '')
      return typeof cached === 'string' ? JSON.parse(cached) : cached
    }

    console.log('[MENU CACHE] Miss for restaurant:', restaurantId, categoryId ? `(category ${categoryId})` : '')
    return null
  } catch (err) {
    console.error('[MENU CACHE] Redis error, falling back to DB:', err)
    return null
  }
}

export async function setCachedMenu(restaurantId: string, menuData: unknown, categoryId?: string) {
  try {
    const cacheKey = categoryId
      ? CacheKeys.menuCategory(restaurantId, categoryId)
      : CacheKeys.menu(restaurantId)
    await getRedis().setex(cacheKey, TTL.MENU, JSON.stringify(menuData))
    console.log('[MENU CACHE] Stored for restaurant:', restaurantId, categoryId ? `(category ${categoryId})` : '')
  } catch (err) {
    console.error('[MENU CACHE] Failed to cache menu:', err)
  }
}

export async function invalidateMenuCache(restaurantId: string) {
  try {
    const [allMenuDeleted, categoryKeys] = await Promise.all([
      getRedis().del(CacheKeys.menu(restaurantId)),
      getRedis().keys(CacheKeys.menuCategory(restaurantId, '*')),
    ])

    if (Array.isArray(categoryKeys) && categoryKeys.length > 0) {
      await getRedis().del(...categoryKeys)
    }

    console.log(
      '[MENU CACHE] Invalidated for restaurant:',
      restaurantId,
      `keys=${1 + (Array.isArray(categoryKeys) ? categoryKeys.length : 0)}`
    )
    return allMenuDeleted
  } catch (err) {
    console.error('[MENU CACHE] Failed to invalidate cache:', err)
    return 0
  }
}
