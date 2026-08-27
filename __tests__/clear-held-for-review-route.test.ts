/**
 * POST /api/admin/orders/held-for-review/clear — the gate and the scope.
 *
 * THREE CLAIMS, AND ONLY ONE OF THEM IS A STATUS CODE.
 *
 *   1. Without `orders:update` the request is refused AND THE ACTION IS NEVER CALLED. A 403 from a
 *      route that has already run the sweep is not a gate, it is a receipt. This repo has already
 *      shipped a security chain that reported REFUSED while being completely dead, so a refusal is
 *      only evidence when something also proves the thing behind it was live — hence the positive
 *      control below, where the SAME setup with the permission present does run it.
 *
 *   2. The venue is resolved server-side and the permission is checked against THAT id, so the gate
 *      and the blast radius are the same value. A body that names a restaurant is ignored.
 *
 *   3. No order ids are read from the body. The freshness guard is that every order is re-queried
 *      immediately before its write, and a list posted by a browser is a list gathered earlier.
 */
import { POST } from '@/app/api/admin/orders/held-for-review/clear/route'

const RESTAURANT = 'rest-mingle'
const OTHER = 'rest-not-yours'

const getUserFromRequest = jest.fn()
const getRestaurantIdForUser = jest.fn()
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: (...args: unknown[]) => getUserFromRequest(...args),
  getRestaurantIdForUser: (...args: unknown[]) => getRestaurantIdForUser(...args),
}))

const authorize = jest.fn()
jest.mock('@/lib/permissions/authorize', () => {
  const { NextResponse } = jest.requireActual<typeof import('next/server')>('next/server')
  return {
    // The REAL requirePermission shape, driven by a mocked authorize(), so the route is exercised
    // through the same helper every other admin route uses rather than through a stand-in.
    requirePermission: async (userId: string, restaurantId: string, permission: string) =>
      (await authorize(userId, restaurantId, permission))
        ? null
        : NextResponse.json(
            { error: 'You do not have permission to perform this action.' },
            { status: 403 },
          ),
  }
})

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({ __marker: 'server-client' }),
}))

const clearHeldForReview = jest.fn()
jest.mock('@/lib/orders/clear-held-for-review', () => ({
  clearHeldForReview: (...args: unknown[]) => clearHeldForReview(...args),
}))

function post(body?: unknown) {
  return new Request('https://example.test/api/admin/orders/held-for-review/clear', {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const SUMMARY = {
  startedAt: 'a',
  finishedAt: 'b',
  requestedBy: 'user-1',
  venues: [],
  outcomes: [],
  counts: {},
  cancelledIds: [],
  paidIds: [],
  heldForAmountReviewIds: [],
  unverifiableIds: [],
  skippedIds: [],
  gatewayAsks: 0,
  gatewayAsksFailed: 0,
  allGatewayCallsFailed: false,
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue({ id: 'user-1' })
  getRestaurantIdForUser.mockReset().mockResolvedValue(RESTAURANT)
  authorize.mockReset().mockResolvedValue(true)
  clearHeldForReview.mockReset().mockResolvedValue(SUMMARY)
})

describe('the gate', () => {
  it('refuses without orders:update and never reaches the action', async () => {
    authorize.mockResolvedValue(false)
    const res = await POST(post())
    expect(res.status).toBe(403)
    // THE HALF THAT MAKES THE 403 MEAN SOMETHING.
    expect(clearHeldForReview).not.toHaveBeenCalled()
  })

  it('runs it WITH orders:update — the positive control for the refusal above', async () => {
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, summary: SUMMARY })
    expect(clearHeldForReview).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith('user-1', RESTAURANT, 'orders:update')
  })

  it('401s an unauthenticated caller without touching the database', async () => {
    getUserFromRequest.mockRejectedValue(new Error('Invalid or expired session. Sign in again.'))
    const res = await POST(post())
    expect(res.status).toBe(401)
    expect(getRestaurantIdForUser).not.toHaveBeenCalled()
    expect(clearHeldForReview).not.toHaveBeenCalled()
  })
})

describe('the scope', () => {
  it('acts on the session\'s own venue and ignores one named in the body', async () => {
    await POST(post({ restaurantId: OTHER, orderIds: ['o-1', 'o-2'] }))
    const params = clearHeldForReview.mock.calls[0][1] as Record<string, unknown>
    expect(params.restaurantId).toBe(RESTAURANT)
    expect(params.requestedBy).toBe('user-1')
    // The permission was checked against the SAME id the action was given.
    expect(authorize).toHaveBeenCalledWith('user-1', RESTAURANT, 'orders:update')
  })

  it('takes no order ids from the caller at all', async () => {
    await POST(post({ orderIds: ['o-1', 'o-2', 'o-3'] }))
    const params = clearHeldForReview.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(params).sort()).toEqual(['requestedBy', 'restaurantId'].sort())
    expect(JSON.stringify(params)).not.toContain('o-1')
  })
})

describe('failure', () => {
  it('500s when the held set cannot be read, and never leaks the database error to the client', async () => {
    clearHeldForReview.mockRejectedValue(new Error('relation "orders" does not exist'))
    const res = await POST(post())
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('clear_run_failed')
    expect(JSON.stringify(body)).not.toContain('relation')
  })
})
