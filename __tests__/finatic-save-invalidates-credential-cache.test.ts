/**
 * PATCH /api/admin/restaurant/finatic must invalidate the restaurant credential cache.
 *
 * ============================================================================================
 * THE DEFECT THIS PINS
 * ============================================================================================
 *
 * getCachedRestaurantCredentials (lib/cache/restaurant-cache.ts) reads Redis BEFORE Supabase.
 * The route updated restaurants.finatic_merchant_no / finatic_store_no and returned success
 * without touching the cache, so the payment gate
 * (lib/payments/finatic-restaurant-credentials.ts's `if (!merchantNo || !storeNo)`) kept reading
 * the pre-save value for up to a full TTL.RESTAURANT.
 *
 * Measured on production 2026-09-01: Chownow Nedbank (38c493cf-a665-42c5-9c3e-858fbdb52b40) had
 * correct credentials in the row and Redis still held
 * {"merchantNo":"","storeNo":"", ...} with 1957 seconds to live. Two terminals told staff "card
 * payments are not set up at this venue" for a venue that was set up. The row was right; the
 * cache was what the gate actually read.
 *
 * ============================================================================================
 * WHY THE ASSERTION IS ON THE CACHE MODULE AND NOT ON A RETURNED VALUE
 * ============================================================================================
 *
 * The route's response is `{ success: true }` either way -- that is precisely why the bug was
 * invisible. Nothing observable about a successful save changes when the invalidation is removed,
 * so the only honest place to assert is the call itself. A test written against the response
 * body would pass with the fix deleted, which is the failure mode this whole file exists to
 * prevent.
 */
import { PATCH } from '@/app/api/admin/restaurant/finatic/route'

const RESTAURANT = '38c493cf-a665-42c5-9c3e-858fbdb52b40'

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-1' }),
  getRestaurantIdForUser: async () => RESTAURANT,
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

const invalidateRestaurantCache = jest.fn(async () => {})
jest.mock('@/lib/cache/restaurant-cache', () => ({
  invalidateRestaurantCache: (...args: unknown[]) =>
    invalidateRestaurantCache(...(args as [])),
}))

/** Set per-test so the update can be made to fail. */
let updateError: { message: string } | null = null
let updatedWith: Record<string, unknown> | null = null
/** Ordering witness: what had already happened when the cache was invalidated. */
let updateCompletedBeforeInvalidate = false

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: () => ({
      update(values: Record<string, unknown>) {
        updatedWith = values
        return {
          eq: async () => {
            updateCompletedBeforeInvalidate = true
            return { error: updateError }
          },
        }
      },
    }),
  }),
}))

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/admin/restaurant/finatic', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  invalidateRestaurantCache.mockClear()
  updateError = null
  updatedWith = null
  updateCompletedBeforeInvalidate = false
})

describe('saving Finatic credentials invalidates the credential cache', () => {
  it('invalidates the cache for the restaurant that was saved', async () => {
    const res = await patch({ merchantNo: '342600171186', storeNo: '4426017127' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    // The load-bearing assertion. Without the fix this is 0 calls.
    expect(invalidateRestaurantCache).toHaveBeenCalledTimes(1)
    expect(invalidateRestaurantCache).toHaveBeenCalledWith(RESTAURANT)
  })

  it('writes the credentials and only then invalidates', async () => {
    await patch({ merchantNo: '342600171186', storeNo: '4426017127' })

    expect(updatedWith).toMatchObject({
      finatic_merchant_no: '342600171186',
      finatic_store_no: '4426017127',
    })
    // Invalidating BEFORE the write would race a concurrent read that re-caches the old row.
    expect(updateCompletedBeforeInvalidate).toBe(true)
    expect(invalidateRestaurantCache).toHaveBeenCalled()
  })

  it('does NOT invalidate when the update failed', async () => {
    updateError = { message: 'permission denied for table restaurants' }

    const res = await patch({ merchantNo: '342600171186', storeNo: '4426017127' })

    expect(res.status).not.toBe(200)
    // Nothing changed, so discarding a good cache entry would be pure cost.
    expect(invalidateRestaurantCache).not.toHaveBeenCalled()
  })

  it('invalidates when credentials are CLEARED, not only when they are set', async () => {
    // The dangerous direction: clearing to null must not leave a populated entry cached, or a
    // venue whose credentials were revoked keeps transacting on them until the TTL expires.
    await patch({ merchantNo: '', storeNo: '' })

    expect(updatedWith).toMatchObject({
      finatic_merchant_no: null,
      finatic_store_no: null,
    })
    expect(invalidateRestaurantCache).toHaveBeenCalledWith(RESTAURANT)
  })
})
