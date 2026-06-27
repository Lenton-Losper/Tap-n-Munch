import { Redis } from '@upstash/redis'

export function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Upstash Redis environment variables are not configured')
  return new Redis({ url, token })
}

export const CacheKeys = {
  menu: (restaurantId: string) => `menu:v2:${restaurantId}`,
  menuCategory: (restaurantId: string, categoryId: string) =>
    `menu:v2:${restaurantId}:category:${categoryId}`,
  restaurant: (restaurantId: string) => `restaurant:${restaurantId}`,
  tab: (restaurantId: string, tableNumber: number) =>
    `tab:${restaurantId}:table:${tableNumber}`,
  idempotency: (key: string) => `idempotency:${key}`,
  rateLimit: (restaurantId: string, tableNumber: number) =>
    `rate:orders:${restaurantId}:table:${tableNumber}`,
}

export const TTL = {
  MENU: 600,
  RESTAURANT: 3600,
  TAB: 300,
  IDEMPOTENCY: 86400,
  RATE_LIMIT: 60,
}
