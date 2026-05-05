import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

export const CacheKeys = {
  menu: (restaurantId: string) => `menu:${restaurantId}`,
  menuCategory: (restaurantId: string, categoryId: string) =>
    `menu:${restaurantId}:category:${categoryId}`,
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
