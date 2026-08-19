/**
 * THE SESSION'S RESTAURANT MUST FOLLOW THE USER'S CHOICE, AND THE CHOICE MUST GRANT NOTHING.
 *
 * Context: on 2026-08-19 an organisation held three restaurants for the first time, and the owner
 * had no way to reach the newest one. app/choose-context had always let a user pick, writing to
 * user_active_context -- but the session bootstrap never read that table, so the pick changed only
 * the login destination.
 *
 * THE POSITIVE CONTROL IS THE SECURITY HALF, and it is the reason this is a pure function: a
 * stored context naming a restaurant the user does NOT belong to must be discarded. Memberships get
 * revoked; the stored row does not. If a stale preference could still select a restaurant, a
 * removed staff member would keep a working session against a business they were removed from --
 * and every widening test below would still pass while that was true.
 */
export {} // module scope

import { pickSessionRestaurant } from '@/lib/auth/pick-session-restaurant'

const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const NEDBANK = '38c493cf-a665-42c5-9c3e-858fbdb52b40'
const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'

describe('following the stored choice', () => {
  it('selects the stored restaurant when the user belongs to it', () => {
    expect(
      pickSessionRestaurant({
        memberRestaurantIds: [RIVIERA, NEDBANK],
        storedRestaurantId: NEDBANK,
      }),
    ).toEqual({ restaurantId: NEDBANK, source: 'stored-context' })
  })

  it('does not merely return the first membership when a valid choice exists', () => {
    // The defect in one line: before the fix this returned RIVIERA no matter what was stored,
    // and the second location was unreachable.
    const picked = pickSessionRestaurant({
      memberRestaurantIds: [RIVIERA, NEDBANK],
      storedRestaurantId: NEDBANK,
    })
    expect(picked.restaurantId).not.toBe(RIVIERA)
  })
})

describe('POSITIVE CONTROL — a stored choice grants nothing', () => {
  it('DISCARDS a stored restaurant the user does not belong to', () => {
    // flashtapapp2 has no restaurant_users row on FNB ChowNow. A stored context naming it must
    // not select it -- if this ever passes through, user_active_context has become an
    // authorisation table, which it is not and must never be.
    const picked = pickSessionRestaurant({
      memberRestaurantIds: [RIVIERA, NEDBANK],
      storedRestaurantId: FNB_CHOWNOW,
    })
    expect(picked.restaurantId).toBe(RIVIERA)
    expect(picked.source).toBe('first-membership')
  })

  it('does not invent a restaurant for a user who belongs to none', () => {
    // The revoked-access case: every membership gone, a stale preference left behind.
    expect(
      pickSessionRestaurant({ memberRestaurantIds: [], storedRestaurantId: NEDBANK }),
    ).toEqual({ restaurantId: null, source: 'none' })
  })
})

describe('the unchanged paths', () => {
  it('falls back to the first membership when nothing is stored', () => {
    expect(
      pickSessionRestaurant({ memberRestaurantIds: [RIVIERA, NEDBANK], storedRestaurantId: null }),
    ).toEqual({ restaurantId: RIVIERA, source: 'first-membership' })
  })

  it('is unaffected for a single-restaurant account, stored or not', () => {
    // The overwhelming majority of accounts. Whatever else changes, this must not.
    for (const stored of [null, undefined, RIVIERA, FNB_CHOWNOW]) {
      expect(
        pickSessionRestaurant({ memberRestaurantIds: [RIVIERA], storedRestaurantId: stored }).restaurantId,
      ).toBe(RIVIERA)
    }
  })

  it('returns null for no memberships and no preference', () => {
    expect(
      pickSessionRestaurant({ memberRestaurantIds: [], storedRestaurantId: null }).restaurantId,
    ).toBeNull()
  })
})
