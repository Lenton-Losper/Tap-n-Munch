/**
 * Staging verification for the restaurant-cache.ts fail-open fix.
 * Exercises the real getCachedRestaurantCredentials/invalidateRestaurantCache source
 * against real staging Supabase data, with Redis deliberately broken and then working,
 * to prove both the fallback and the happy path.
 */
import { getCachedRestaurantCredentials, invalidateRestaurantCache } from '../lib/cache/restaurant-cache'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // staging fixture restaurant

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const mode = process.argv[2]

  if (mode === '--broken-redis') {
    log('UPSTASH_REDIS_REST_URL (should be invalid)', process.env.UPSTASH_REDIS_REST_URL)
    const start = Date.now()
    try {
      const creds = await getCachedRestaurantCredentials(RESTAURANT_ID)
      log('RESULT: getCachedRestaurantCredentials SUCCEEDED despite broken Redis', {
        creds,
        elapsedMs: Date.now() - start,
      })
      console.log('\nVERIFY_FALLBACK_OK')
    } catch (err) {
      log('RESULT: getCachedRestaurantCredentials THREW (fallback did NOT work)', {
        message: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - start,
      })
      console.log('\nVERIFY_FALLBACK_FAILED')
      process.exit(1)
    }
    return
  }

  if (mode === '--happy-path') {
    // Invalidate first so this run starts from a real cache miss.
    await invalidateRestaurantCache(RESTAURANT_ID)

    const missStart = Date.now()
    const missResult = await getCachedRestaurantCredentials(RESTAURANT_ID)
    log('cache MISS call result', { missResult, elapsedMs: Date.now() - missStart })

    const hitStart = Date.now()
    const hitResult = await getCachedRestaurantCredentials(RESTAURANT_ID)
    log('cache HIT call result (should be fast, from Redis)', { hitResult, elapsedMs: Date.now() - hitStart })

    const same = JSON.stringify(missResult) === JSON.stringify(hitResult)
    log('miss/hit results identical?', same)
    console.log(same ? '\nVERIFY_HAPPY_PATH_OK' : '\nVERIFY_HAPPY_PATH_MISMATCH')
    if (!same) process.exit(1)
    return
  }

  throw new Error('Usage: --broken-redis | --happy-path')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
